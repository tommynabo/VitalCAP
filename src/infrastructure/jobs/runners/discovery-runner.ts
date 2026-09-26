import { randomUUID } from "node:crypto";
import type { EngineType } from "@/domain/campaigns/types";
import { getCampaignById, listActiveCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import {
  claimDiscoveryJobs,
  completeDiscoveryJob,
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
  updateSearchSeedAfterRun,
  getRemainingDiscoveryTarget,
} from "@/infrastructure/neon/repositories/discovery";
import { getProviderRunByRequestKey, reserveApifyProviderRun, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getDayBounds } from "@/lib/time/day-bounds";
import { recordSeedRun } from "@/services/discovery/geography-planner";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, LINKEDIN_OWNER_ROLE_QUERIES, ICP_CATEGORY_TERMS } from "@/services/discovery/spain-search-catalog";
import { createDiscoveryEngine } from "./engine-factory";
import type { SearchSeed } from "@/domain/discovery/types";

const DISCOVERY_JOB_TYPE = "run_engine_batch";
const MAX_SEEDS_PER_JOB = 3;

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
  for (const campaign of campaigns) {
    if (campaign.engineType !== "maps_fast") continue; // deferred engines remain paused until their providers are enabled
    if (await hasInFlightDiscoveryJob(campaign.id)) continue;
    await bootstrapSearchSeeds(campaign.id, campaign.engineType, catalogForEngine(campaign.id, campaign.engineType));
    await enqueueDiscoveryJob({
      campaignId: campaign.id,
      type: DISCOVERY_JOB_TYPE,
      payload: { engineType: campaign.engineType },
      idempotencyKey: `discovery:${campaign.id}:${DISCOVERY_JOB_TYPE}`,
    });
    enqueued += 1;
  }
  return enqueued;
}

interface DiscoveryJobPayload {
  engineType: EngineType;
}

async function executeDiscoveryJob(job: { id: string; campaignId: string; payload: DiscoveryJobPayload }): Promise<number> {
  const campaign = await getCampaignById(job.campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${job.campaignId}`);
  if (campaign.status !== "active" || !campaign.autopilotEnabled) {
    throw new Error(`Scheduled discovery is disabled for campaign ${job.campaignId}.`);
  }
  const settings = await getAutopilotSettings(campaign.workspaceId);
  if (getEffectiveAutopilotState(settings) !== "running") return 0;

  const engine = createDiscoveryEngine(campaign.workspaceId, job.payload.engineType);
  const persistedSeeds = await listSearchSeedsForCampaignEngine(campaign.id, job.payload.engineType);
  if ("seeds" in engine) (engine as { seeds: SearchSeed[] }).seeds = persistedSeeds;

  const remainingTarget = await getRemainingDiscoveryTarget(campaign.id, campaign.dailySoftTarget, campaign.timeZone);
  if (remainingTarget <= 0) return 0;
  const { seeds } = await engine.planDiscoveryBatch({ campaignId: campaign.id, remainingTarget });
  const boundedSeeds = seeds.slice(0, MAX_SEEDS_PER_JOB);

  let totalRawCandidates = 0;
  for (const seed of boundedSeeds) {
    const startedAt = new Date();
    const requestKey = `apify:${campaign.id}:${seed.id}:${getDayBounds(campaign.timeZone, startedAt).start.toISOString()}`;
    let seedRunId: string | null = null;
    let reservationId: string | null = null;
    if (engine.usesAsyncProvider) {
      const reservation = await reserveApifyProviderRun({
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        operation: "maps_search",
        requestKey,
        seedId: seed.id,
        itemsRequested: Math.max(1, Math.min(campaign.dailySoftTarget, 1000)),
        metadata: { seedId: seed.id, discoveryJobId: job.id, query: seed.query, geography: seed.geography },
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
      await updateProviderRun(reservationId, { metadata: { seedId: seed.id, seedRunId, discoveryJobId: job.id, query: seed.query, geography: seed.geography } });
    } else if (await getProviderRunByRequestKey(requestKey)) {
      continue;
    }

    const result = await engine.executeDiscovery({ seed, dryRun: false, requestKey });
    const finishedAt = new Date();

    if (result.providerRun) {
      if (!reservationId || !seedRunId) throw new Error(`Async provider run ${requestKey} had no local reservation.`);
      await updateProviderRun(reservationId, {
        actorId: result.providerRun.actorId,
        externalRunId: result.providerRun.externalRunId,
        externalDatasetId: result.providerRun.externalDatasetId,
        status: result.providerRun.status,
        costUsd: result.providerRun.costUsd,
        metadata: { ...result.providerRun.metadata, seedId: seed.id, seedRunId, discoveryJobId: job.id, query: seed.query, geography: seed.geography },
      });
      continue;
    }

    if (reservationId) {
      await updateProviderRun(reservationId, { error: "Async provider did not return a run; operator reconciliation required." });
      continue;
    }

    await insertSearchSeedRun({
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
              rawPayload: candidate.rawPayload,
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

    const updatedSeed = recordSeedRun(seed, {
      rawCount: result.rawCandidates.length,
      uniqueCount: result.rawCandidates.length,
      readyCount: 0,
      finishedAt: finishedAt.toISOString(),
    });
    await updateSearchSeedAfterRun(updatedSeed);

    totalRawCandidates += result.rawCandidates.length;
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
      await failDiscoveryJob({ workerId, job, error, now });
    }
  }

  for (const workspaceId of workspaceIds) {
    const state = getEffectiveAutopilotState(await getAutopilotSettings(workspaceId));
    if (state === "paused") pausedWorkspaces += 1;
    if (state === "emergency_stopped") emergencyStoppedWorkspaces += 1;
  }
  return { jobsClaimed, rawCandidatesProduced, pausedWorkspaces, emergencyStoppedWorkspaces };
}
