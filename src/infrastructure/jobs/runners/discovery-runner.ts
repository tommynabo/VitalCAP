import { randomUUID } from "node:crypto";
import type { EngineType } from "@/domain/campaigns/types";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
import { getCampaignById, listActiveCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import {
  claimDiscoveryJobs,
  completeDiscoveryJob,
  deferDiscoveryJob,
  failDiscoveryJob,
  enqueueDiscoveryJob,
  enqueueProcessingJob,
} from "@/infrastructure/neon/repositories/job-queue";
import {
  bootstrapSearchSeeds,
  hasInFlightDiscoveryJob,
  insertRawCandidates,
  insertSearchSeedRun,
  listSearchSeedsForCampaignEngine,
  refreshSearchSeedQualification,
  getRemainingDiscoveryTarget,
  updateSearchSeedRun,
} from "@/infrastructure/neon/repositories/discovery";
import { getRecentProviderUsage, reserveApifyProviderRun, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, LINKEDIN_OWNER_ROLE_QUERIES, ICP_CATEGORY_TERMS } from "@/services/discovery/spain-search-catalog";
import { createDiscoveryEngine } from "./engine-factory";
import type { SearchSeed } from "@/domain/discovery/types";
import { evaluateProviderHealth } from "@/services/discovery/provider-health";
import { createProviderRequestKey, normalizeProviderQuery } from "@/services/discovery/provider-request-key";
import { resolvePlanningWindow } from "@/services/autopilot/target-planner";

const DISCOVERY_JOB_TYPE = "run_engine_batch";
const MAX_SEEDS_PER_JOB = 5;
const MAX_RAW_PER_SEED = 100;

function catalogForEngine(campaignId: string, engineType: EngineType): SearchSeed[] {
  if (engineType === "maps_fast" || engineType === "maps_deep") return buildMapsSeedCatalog(campaignId, engineType);
  if (engineType === "google_serp") return buildSerpSeedCatalog(campaignId, "google_serp", ICP_CATEGORY_TERMS);
  if (engineType === "linkedin_owner") return buildSerpSeedCatalog(campaignId, "linkedin_owner", LINKEDIN_OWNER_ROLE_QUERIES);
  return []; // hybrid_fill has no catalog of its own — it always delegates to an already-seeded engine
}

/**
 * Ensures every active, `engineType`-owning campaign has at most one
 * in-flight discovery job — "campaign pause prevents claims" (§24) is
 * enforced entirely by `claimNextDiscoveryJob`'s own `campaigns.status =
 * 'active'` join; this only needs to avoid piling up duplicate pending jobs
 * faster than they can be claimed and drained.
 */
export async function ensureDiscoveryJobsQueued(workspaceId: string): Promise<number> {
  const settings = await getAutopilotSettings(workspaceId);
  if (getEffectiveAutopilotState(settings) !== "running") return 0;
  const campaigns = await listActiveCampaigns(workspaceId);
  let enqueued = 0;
  // Discovery work is now issued by the Autopilot pacing order. This function
  // only remains as a compatibility hook for the discovery cron.
  void campaigns;
  return enqueued;
}

interface DiscoveryJobPayload {
  engineType: EngineType;
  desiredRawCount: number;
  planningWindow?: string;
  reason?: string;
  origin?: "normal" | "rebalance" | "hybrid_fill";
  seedQuery?: string;
  seedGeography?: string;
}

async function executeDiscoveryJob(job: { id: string; campaignId: string; payload: DiscoveryJobPayload }): Promise<number> {
  const campaign = await getCampaignById(job.campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${job.campaignId}`);
  if (campaign.status !== "active" || !campaign.autopilotEnabled) {
    throw new Error(`Scheduled discovery is disabled for campaign ${job.campaignId}.`);
  }
  const settings = await getAutopilotSettings(campaign.workspaceId);
  if (getEffectiveAutopilotState(settings) !== "running") return 0;

  const engine = createDiscoveryEngine(campaign.workspaceId, job.payload.engineType, campaign.id);
  // Every concrete engine owns a persisted, idempotent seed catalog. Hybrid
  // Fill is intentionally excluded: it routes work to one of these engines
  // rather than creating a duplicate candidate source of its own.
  if (job.payload.engineType !== "hybrid_fill") {
    await bootstrapSearchSeeds(campaign.id, job.payload.engineType, catalogForEngine(campaign.id, job.payload.engineType));
  }
  const persistedSeeds = await listSearchSeedsForCampaignEngine(campaign.id, job.payload.engineType);
  if ("seeds" in engine) (engine as { seeds: SearchSeed[] }).seeds = persistedSeeds;

  const provider = job.payload.engineType === "maps_fast" || job.payload.engineType === "maps_deep" ? "apify" : "serper";
  const providerHealth = evaluateProviderHealth(await getRecentProviderUsage(campaign.workspaceId, provider));
  // The first provider run stays deliberately small. Once one terminal
  // success establishes health, a job can use the full five-seed planning
  // window (5 × 100 raw), still subject to the per-workspace daily raw and
  // spend guards in reserveApifyProviderRun.
  const bootstrapCap = providerHealth === "untested" ? 10 : MAX_SEEDS_PER_JOB * MAX_RAW_PER_SEED;
  const desiredRawCount = Math.min(bootstrapCap, Math.max(0, Math.floor(job.payload.desiredRawCount)));
  if (desiredRawCount <= 0) return 0;
  const maxSeeds = Math.min(MAX_SEEDS_PER_JOB, Math.max(1, Math.ceil(desiredRawCount / 10)));
  const { seeds } = await engine.planDiscoveryBatch({ campaignId: campaign.id, remainingTarget: desiredRawCount });
  const requestedSeed = job.payload.seedQuery && job.payload.seedGeography
    ? seeds.find((seed) => seed.query === job.payload.seedQuery && seed.geography === job.payload.seedGeography)
    : undefined;
  const boundedSeeds = requestedSeed ? [requestedSeed] : seeds.slice(0, maxSeeds);
  if (boundedSeeds.length === 0) return 0;
  let remainingRaw = desiredRawCount;

  let totalRawCandidates = 0;
  for (const [seedIndex, seed] of boundedSeeds.entries()) {
    const requestedItems = Math.min(MAX_RAW_PER_SEED, Math.max(1, Math.ceil(remainingRaw / (boundedSeeds.length - seedIndex))));
    const startedAt = new Date();
    const planningWindow = resolvePlanningWindow(job.payload.planningWindow, startedAt, campaign.timeZone);
    const normalizedQuery = normalizeProviderQuery(`${seed.query} ${seed.geography}`);
    const requestKey = createProviderRequestKey({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      engineType: job.payload.engineType,
      provider,
      query: normalizedQuery,
      planningWindow,
    });
    let seedRunId: string | null = null;
    let reservationId: string | null = null;
    if (engine.usesAsyncProvider) {
      const reservation = await reserveApifyProviderRun({
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        operation: "maps_search",
        requestKey,
        seedId: seed.id,
        itemsRequested: requestedItems,
        metadata: { engineType: job.payload.engineType, seedId: seed.id, discoveryJobId: job.id, query: seed.query, normalizedQuery, geography: seed.geography, planningWindow },
      });
      if (!reservation.created) continue;
      reservationId = reservation.providerRun.id;
      seedRunId = await insertSearchSeedRun({
        seedId: seed.id,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        rawCount: 0,
        uniqueCount: 0,
        readyCount: 0,
        error: null,
      });
      await updateProviderRun(reservationId, { metadata: { engineType: job.payload.engineType, seedId: seed.id, seedRunId, discoveryJobId: job.id, query: seed.query, normalizedQuery, geography: seed.geography, planningWindow } });
    }

    let result;
    try {
      result = await engine.executeDiscovery({ seed, dryRun: false, requestKey, maxResults: requestedItems, planningWindow });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reservationId) {
        await updateProviderRun(reservationId, { status: "failed", finishedAt: new Date(), error: `Provider startup failed: ${message}` });
      }
      if (seedRunId) await updateSearchSeedRun(seedRunId, { finishedAt: new Date().toISOString(), error: `Provider startup failed: ${message}` });
      throw error;
    }
    const finishedAt = new Date();

    if (result.providerRun) {
      if (!reservationId || !seedRunId) throw new Error(`Async provider run ${requestKey} had no local reservation.`);
      await updateProviderRun(reservationId, {
        actorId: result.providerRun.actorId,
        externalRunId: result.providerRun.externalRunId,
        externalDatasetId: result.providerRun.externalDatasetId,
        status: result.providerRun.status,
        costUsd: result.providerRun.costUsd,
        metadata: { ...result.providerRun.metadata, engineType: job.payload.engineType, seedId: seed.id, seedRunId, discoveryJobId: job.id, query: seed.query, geography: seed.geography },
      });
      continue;
    }

    if (reservationId) {
      const message = "Async provider completed without an external run identifier.";
      await updateProviderRun(reservationId, { status: "failed", finishedAt, error: message });
      if (seedRunId) await updateSearchSeedRun(seedRunId, { finishedAt: finishedAt.toISOString(), error: message });
      throw new Error(message);
    }

    if (result.providerErrors > 0) throw new Error(`${result.providerErrors} provider error(s) while executing discovery.`);

    const completedSeedRunId = await insertSearchSeedRun({
      seedId: seed.id,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      rawCount: result.rawCandidates.length,
      uniqueCount: result.rawCandidates.length,
      readyCount: 0,
      error: result.providerErrors > 0 ? `${result.providerErrors} provider error(s)` : null,
    });

    const insertedIds =
      result.rawCandidates.length > 0
        ? await insertRawCandidates(
            result.rawCandidates.map((candidate) => ({
              discoveryJobId: job.id,
              campaignId: campaign.id,
              engineType: candidate.engineType,
              sourceExternalId: candidate.sourceExternalId,
              sourceUrl: candidate.sourceUrl,
              sourceFingerprint: candidate.sourceExternalId || candidate.sourceUrl || randomUUID(),
              rawPayload: candidate.rawPayload,
              searchSeedRunId: completedSeedRunId,
              providerRunId: candidate.providerRunId,
            })),
          )
        : [];

    for (const rawCandidateId of insertedIds) {
      await enqueueProcessingJob({
        campaignId: campaign.id,
        type: "process_raw_candidate",
        payload: { rawCandidateId },
        idempotencyKey: `raw_candidate:${rawCandidateId}`,
      });
    }

    await refreshSearchSeedQualification(completedSeedRunId);

    totalRawCandidates += result.rawCandidates.length;
    remainingRaw = Math.max(0, remainingRaw - result.rawCandidates.length);
    if (remainingRaw === 0) break;
  }

  return totalRawCandidates;
}

export interface DiscoveryRunnerResult {
  jobsClaimed: number;
  rawCandidatesProduced: number;
  pausedWorkspaces: number;
  emergencyStoppedWorkspaces: number;
}

/** One bounded batch of discovery work across every workspace: enqueue-if-missing per workspace, then a single global claim+execute loop of up to `maxJobsPerTick` jobs (claims are global — not workspace-scoped — so this must not be called once per workspace). Called once per `/api/cron/discovery` invocation. */
export async function runDiscoveryCronTick(maxJobsPerTick: number, now: Date = new Date()): Promise<DiscoveryRunnerResult> {
  const workspaceIds = await listWorkspaceIds();
  for (const workspaceId of workspaceIds) {
    await ensureDiscoveryJobsQueued(workspaceId);
  }

  const workerId = `cron-discovery-${randomUUID()}`;
  let jobsClaimed = 0;
  let rawCandidatesProduced = 0;
  let pausedWorkspaces = 0;
  let emergencyStoppedWorkspaces = 0;

  const jobs = await claimDiscoveryJobs<DiscoveryJobPayload>({ workerId, batchSize: maxJobsPerTick, now });
  for (const job of jobs) {
    jobsClaimed += 1;
    try {
      rawCandidatesProduced += await executeDiscoveryJob(job);
      await completeDiscoveryJob({ jobId: job.id, workerId, now });
    } catch (error) {
      if (error instanceof ProviderBudgetExceededError) {
        await deferDiscoveryJob({ jobId: job.id, workerId, nextAttemptAt: error.retryAt, reason: error.message });
      } else {
        await failDiscoveryJob({ workerId, job, error, now });
      }
    }
  }

  for (const workspaceId of workspaceIds) {
    const state = getEffectiveAutopilotState(await getAutopilotSettings(workspaceId));
    if (state === "paused") pausedWorkspaces += 1;
    if (state === "emergency_stopped") emergencyStoppedWorkspaces += 1;
  }
  return { jobsClaimed, rawCandidatesProduced, pausedWorkspaces, emergencyStoppedWorkspaces };
}
