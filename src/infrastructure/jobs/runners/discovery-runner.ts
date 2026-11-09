import { randomUUID } from "node:crypto";
import type { EngineType } from "@/domain/campaigns/types";
import type { JobRecord } from "@/domain/discovery/types";
import type { AutopilotSettings } from "@/domain/autopilot/types";
import { getProviderFailureRetryAt, ProviderBudgetExceededError, ProviderConfigurationError, ProviderFailureError } from "@/domain/providers/errors";
import { getCampaignById, listActiveCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import {
  claimDiscoveryJobs,
  completeDiscoveryJob,
  deferDiscoveryJob,
  failDiscoveryJob,
  enqueueDiscoveryJob,
  enqueueProcessingJob,
  persistScopedSmokeEvidence,
} from "@/infrastructure/neon/repositories/job-queue";
import {
  bootstrapSearchSeeds,
  hasInFlightDiscoveryJob,
  insertRawCandidates,
  insertSearchSeedRun,
  listSearchSeedsForCampaignEngine,
  refreshSearchSeedQualification,
  getRemainingDiscoveryTarget,
  getSeedEconomicPerformance,
  updateSearchSeedRun,
} from "@/infrastructure/neon/repositories/discovery";
import { getApifyRecoverySnapshot, getApifyReservationFailureDetails, getLatestProviderEconomicPacingStates, getRecentProviderUsage, getSerperRecoveryState, getTodaySpendUsd, recordProviderRun, reserveApifyProviderRun, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getMultiNicheRolloutEntry } from "@/services/autopilot/multi-niche-rollout";
import { WATCHDOG_QUEUE_PAUSE_REASON } from "@/services/autopilot/watchdog-pause-policy";
import { buildCampaignSeedCatalog, buildMapsSeedCatalog, buildSerpSeedCatalog, LINKEDIN_OWNER_ROLE_QUERIES, ICP_CATEGORY_TERMS } from "@/services/discovery/spain-search-catalog";
import { getNicheId } from "@/services/discovery/niche-profiles";
import { createDiscoveryEngine } from "./engine-factory";
import type { SearchSeed } from "@/domain/discovery/types";
import { createApifyConfigurationFingerprint, createApifyCredentialFingerprint, evaluateProviderHealth, getApifyAllocationHealth, isCurrentApifyRecoveryCredential, resolveApifyDiscoveryWorkMode } from "@/services/discovery/provider-health";
import { createProviderRequestKey, normalizeProviderQuery } from "@/services/discovery/provider-request-key";
import { resolvePlanningWindow } from "@/services/autopilot/target-planner";
import { getMapsEnv } from "@/lib/config/env";
import { logEvent } from "@/lib/observability/structured-logger";
import { getApifyFailureClass, getApifyFailureKind } from "@/infrastructure/providers/maps/apify-client";
import { ApifyClient } from "@/infrastructure/providers/maps/apify-client";
import { getDayBounds } from "@/lib/time/day-bounds";
import {
  hasConfidentSeedEconomicEvidence,
  planSeedBatches,
  scoreSeedEconomicPerformance,
  type SeedBatchPlan,
  type SeedEconomicPerformance,
} from "@/services/discovery/seed-economics";
import type { EconomicPacingState } from "@/services/autopilot/economic-pacing";
import { computeProviderBudgetPacing, getElapsedOperatingFraction } from "@/services/autopilot/economic-pacing";
import {
  APIFY_DEFAULT_BATCH_COST_LIMIT_USD,
  APIFY_MAX_RESULTS_PER_SEARCH,
  resolveApifyMaxResults,
} from "@/services/discovery/apify-request-capacity";

const DISCOVERY_JOB_TYPE = "run_engine_batch";
const MAX_SEEDS_PER_JOB = 5;
const MAX_RAW_PER_SEED = 100;

export function resolveScopedColdStartBatches(input: {
  probeAuthorized: boolean;
  seed: SearchSeed;
  performance?: SeedEconomicPerformance;
  existingBatches: SeedBatchPlan[];
  desiredRawCount: number;
  now: Date;
}): { batches: SeedBatchPlan[]; usedColdStartBypass: boolean; blockedReason: string | null } {
  if (!input.probeAuthorized || input.existingBatches.length > 0) {
    return { batches: input.existingBatches, usedColdStartBypass: false, blockedReason: null };
  }
  const policy = scoreSeedEconomicPerformance(input.seed, input.performance, input.now);
  if (!policy.eligible) {
    return { batches: [], usedColdStartBypass: false, blockedReason: "seed_cooldown_or_policy_block" };
  }
  if (hasConfidentSeedEconomicEvidence(input.performance) || !policy.exploration) {
    return { batches: [], usedColdStartBypass: false, blockedReason: "economic_evidence_mature" };
  }
  const requestedItems = Math.min(5, Math.max(0, Math.floor(input.desiredRawCount)), policy.maxResults);
  if (requestedItems <= 0) {
    return { batches: [], usedColdStartBypass: false, blockedReason: "probe_candidate_limit_zero" };
  }
  return {
    batches: [{ seed: input.seed, requestedItems, policy }],
    usedColdStartBypass: true,
    blockedReason: null,
  };
}

function catalogForEngine(campaign: Awaited<ReturnType<typeof getCampaignById>>, engineType: EngineType): SearchSeed[] {
  if (!campaign) return [];
  const niche = getNicheId(campaign.engineConfig?.niche);
  if (niche) return buildCampaignSeedCatalog(campaign.id, engineType, niche);
  if (engineType === "maps_fast" || engineType === "maps_deep") return buildMapsSeedCatalog(campaign.id, engineType);
  if (engineType === "google_serp") return buildSerpSeedCatalog(campaign.id, "google_serp", ICP_CATEGORY_TERMS);
  if (engineType === "linkedin_owner") return buildSerpSeedCatalog(campaign.id, "linkedin_owner", LINKEDIN_OWNER_ROLE_QUERIES);
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
  maxCandidates?: number;
  maxProviderQueries?: number;
  probeMode?: boolean;
  smokeExecutionId?: string;
  seedId?: string;
  planningWindow?: string;
  reason?: string;
  origin?: "normal" | "rebalance" | "hybrid_fill" | "recovery_probe";
  recoveryCredentialFingerprint?: string;
  economicPaceState?: EconomicPacingState;
  seedQuery?: string;
  seedGeography?: string;
  scopedSmoke?: boolean;
}

type PreReservationStage = "bootstrap" | "load_seeds" | "plan_batch";

export function canExecuteWatchdogRecoveryJob(
  settings: Pick<AutopilotSettings, "enabled" | "systemPaused" | "systemPauseReason" | "emergencyStopped">,
  job: Pick<JobRecord, "watchdogRecovery">,
): boolean {
  return job.watchdogRecovery === true
    && settings.enabled
    && settings.systemPaused
    && settings.systemPauseReason === WATCHDOG_QUEUE_PAUSE_REASON
    && !settings.emergencyStopped;
}

function getErrorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function getSafeErrorMessage(error: unknown, seeds: readonly SearchSeed[]): string {
  if (error instanceof Error && error.name === "ZodError") return "Environment validation failed.";
  let message = error instanceof Error ? error.message : "Non-Error exception.";
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && /token|secret|database[_-]?url|api[_-]?key|password/i.test(name)) {
      message = message.split(value).join("[REDACTED]");
    }
  }
  const seedTerms = new Set(seeds.flatMap((seed) => [seed.query, seed.geography]).filter((term) => term.length >= 2));
  for (const term of seedTerms) {
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    message = message.replace(new RegExp(escapedTerm, "gi"), "[seed]");
  }
  const payloadStart = [message.indexOf("{"), message.indexOf("[")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (payloadStart !== undefined) message = message.slice(0, payloadStart);

  return message
    .replace(/\bapify_api_[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:database[_-]?url|password|api[_-]?key|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[DATABASE_URL_REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 300) || "Pre-reservation operation failed.";
}

async function runPreReservationStage<T>(
  job: { id: string; payload: DiscoveryJobPayload },
  stage: PreReservationStage,
  operation: () => Promise<T>,
  sensitiveSeeds: readonly SearchSeed[] = [],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logEvent("error", "discovery.pre_reservation_failed", {
      correlationId: job.id,
      discoveryJobId: job.id,
      engineType: job.payload.engineType,
      stage,
      errorClass: getErrorClass(error),
      safeErrorMessage: getSafeErrorMessage(error, sensitiveSeeds),
    });
    throw error;
  }
}

type PreProviderStage =
  | "campaign_guard"
  | "load_autopilot_settings"
  | "resolve_autopilot_state"
  | "load_maps_env"
  | "create_configuration_fingerprint"
  | "load_apify_recovery_snapshot"
  | "load_serper_recovery_state"
  | "resolve_apify_allocation_health"
  | "resolve_recovery_work_mode";

async function runPreProviderStage<T>(
  job: { id: string; payload: DiscoveryJobPayload },
  stage: PreProviderStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  const fields = {
    correlationId: job.id,
    discoveryJobId: job.id,
    engineType: job.payload.engineType,
    origin: job.payload.origin ?? "normal",
    stage,
  };
  logEvent("info", "discovery.pre_provider.stage", fields);
  try {
    return await operation();
  } catch (error) {
    const failureKind = error instanceof ProviderFailureError
      ? error.kind
      : error instanceof ProviderBudgetExceededError ? error.budgetKind : undefined;
    const retryAt = error instanceof ProviderFailureError || error instanceof ProviderBudgetExceededError
      ? error.retryAt
      : null;
    logEvent("error", "discovery.pre_provider.failed", {
      ...fields,
      errorClass: getErrorClass(error),
      safeErrorMessage: getSafeErrorMessage(error, []),
      ...(failureKind ? { failureKind } : {}),
      ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
    });
    throw error;
  }
}

export function mergeApifyProviderRunMetadata(
  reservation: Record<string, unknown>,
  provider: Record<string, unknown>,
  runtime: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = { ...reservation, ...provider, ...runtime };
  for (const field of ["credentialFingerprint", "configurationFingerprint"] as const) {
    if (typeof reservation[field] === "string") metadata[field] = reservation[field];
  }
  return metadata;
}

export function isDefinitiveApifyStartupFailure(failureKind: string | null | undefined): boolean {
  return failureKind === "authentication" || failureKind === "billing" || failureKind === "configuration";
}

export function getApifyStartupCostPatch(failureKind: string | null | undefined): { costUsd: 0 } | Record<string, never> {
  return isDefinitiveApifyStartupFailure(failureKind) ? { costUsd: 0 } : {};
}

export function getApifyDiscoveryBatchCap(recoveryProbe: boolean, providerHealth: string): number {
  return recoveryProbe || providerHealth === "untested"
    ? 10
    : MAX_SEEDS_PER_JOB * MAX_RAW_PER_SEED;
}

interface DiscoveryHandoffCounters {
  providerReservationsCreated: number;
  providerReservationsSkipped: number;
  providerRunsStarted: number;
  providerStartsFailed: number;
  providerJobsDeferred: number;
  rawCandidatesInserted: number;
  rawCandidatesDuplicate: number;
}

export interface ScopedProbeEvidence {
  jobClaimed: boolean;
  providerCallAttempted: boolean;
  providerCallSucceeded: boolean;
  providerCallErrorClass: string | null;
  providerQueriesUsed: number;
  resultsReturned: number;
  rawCandidatesInserted: number;
  duplicates: number;
  candidateCount: number;
}

async function executeDiscoveryJob(
  job: JobRecord<DiscoveryJobPayload>,
  counters: DiscoveryHandoffCounters,
  probeAuthorized = false,
  probeEvidence?: ScopedProbeEvidence,
  authorizedExecutionId?: string,
): Promise<number> {
  const probeMode = probeAuthorized && job.payload.probeMode === true;
  if (job.payload.probeMode && !probeMode) {
    throw new Error("Cold-start probe mode is restricted to the authenticated scoped smoke runner.");
  }
  if (probeMode && (job.payload.scopedSmoke !== true || !job.payload.smokeExecutionId
    || job.payload.smokeExecutionId !== authorizedExecutionId || job.id !== authorizedExecutionId
    || !job.payload.seedId || job.payload.maxProviderQueries !== 1)) {
    throw new Error("Scoped cold-start probe payload is incomplete or exceeds its query bound.");
  }
  if (job.payload.origin === "recovery_probe") {
    const currentCredentialFingerprint = createApifyCredentialFingerprint(getMapsEnv().APIFY_API_TOKEN);
    if (!isCurrentApifyRecoveryCredential(job.payload.recoveryCredentialFingerprint, currentCredentialFingerprint)) {
      logEvent("warn", "apify.recovery_probe_stale_credential", {
        correlationId: job.id,
        discoveryJobId: job.id,
        recoveryCredentialFingerprintPresent: Boolean(job.payload.recoveryCredentialFingerprint),
        currentCredentialConfigured: Boolean(currentCredentialFingerprint),
      });
      return 0;
    }
  }

  const campaign = await runPreProviderStage(job, "campaign_guard", async () => {
    const currentCampaign = await getCampaignById(job.campaignId);
    if (!currentCampaign) throw new Error("Discovery campaign is unavailable.");
    const rollout = getMultiNicheRolloutEntry(currentCampaign.id);
    const scopedDraftAllowed = job.payload.scopedSmoke === true
      && rollout !== null
      && rollout.niche === currentCampaign.engineConfig?.niche
      && currentCampaign.status === "draft"
      && !currentCampaign.autopilotEnabled;
    if (!scopedDraftAllowed && (currentCampaign.status !== "active" || !currentCampaign.autopilotEnabled)) {
      throw new Error("Scheduled discovery is disabled for this campaign.");
    }
    return currentCampaign;
  });
  logEvent("info", "discovery.job.claimed", {
    correlationId: job.id,
    discoveryJobId: job.id,
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    engineType: job.payload.engineType,
    origin: job.payload.origin ?? null,
    desiredRawCount: job.payload.desiredRawCount,
  });
  const settings = await runPreProviderStage(job, "load_autopilot_settings", () => getAutopilotSettings(campaign.workspaceId));
  const autopilotState = await runPreProviderStage(job, "resolve_autopilot_state", () => getEffectiveAutopilotState(settings));
  if (autopilotState !== "running" && !canExecuteWatchdogRecoveryJob(settings, job)) return 0;

  const provider = job.payload.engineType === "maps_fast" || job.payload.engineType === "maps_deep" ? "apify" : "serper";
  let executionEconomicPaceState = job.payload.economicPaceState;
  const mapsEnv = provider === "apify"
    ? await runPreProviderStage(job, "load_maps_env", () => getMapsEnv())
    : null;
  const apifyConfigurationFingerprint = mapsEnv
    ? await runPreProviderStage(job, "create_configuration_fingerprint", () => createApifyConfigurationFingerprint(mapsEnv))
    : null;
  const apifyRecovery = provider === "apify"
    ? await runPreProviderStage(job, "load_apify_recovery_snapshot", () => getApifyRecoverySnapshot(campaign.workspaceId))
    : null;
  const serperRecovery = provider === "serper"
    ? await runPreProviderStage(job, "load_serper_recovery_state", () => getSerperRecoveryState())
    : null;
  const providerHealth = apifyRecovery
    ? await runPreProviderStage(job, "resolve_apify_allocation_health", () => getApifyAllocationHealth(apifyRecovery))
    : serperRecovery?.recoveryProbeEligible
      ? "untested"
      : serperRecovery?.allocationPaused
        ? "paused"
        : evaluateProviderHealth(await getRecentProviderUsage(campaign.workspaceId, provider, 24, serperRecovery?.recoveredAt));
  const requestedRecoveryProbe = job.payload.origin === "recovery_probe";
  const recoveryWorkMode = await runPreProviderStage(job, "resolve_recovery_work_mode", () => provider === "apify" && apifyRecovery
    ? resolveApifyDiscoveryWorkMode({
      providerHealth,
      recoveryProbeEligible: apifyRecovery.recoveryProbeEligible,
      recoveryProbeRequested: requestedRecoveryProbe,
    })
    : "normal");
  const recoveryProbe = recoveryWorkMode === "recovery_probe";
  logEvent("info", "discovery.provider.selected", {
    correlationId: job.id,
    discoveryJobId: job.id,
    provider,
    providerHealth,
    recoveryWorkMode,
    recoveryProbe,
  });
  if (recoveryWorkMode === "skip") {
    logEvent("info", "discovery.provider.deferred", {
      correlationId: job.id,
      discoveryJobId: job.id,
      provider,
      providerHealth,
      recoveryWorkMode,
      nextRecoveryAttemptAt: apifyRecovery?.nextRecoveryAttemptAt?.toISOString() ?? null,
    });
    return 0;
  }
  if (recoveryWorkMode === "defer") {
    const retryAt = apifyRecovery?.nextRecoveryAttemptAt;
    logEvent("info", "discovery.provider.deferred", {
      correlationId: job.id,
      discoveryJobId: job.id,
      provider,
      providerHealth,
      recoveryWorkMode,
      nextRecoveryAttemptAt: retryAt?.toISOString() ?? null,
    });
    if (!retryAt) throw new ProviderConfigurationError("Apify is paused without an eligible recovery time.");
    throw new ProviderFailureError("Apify provider is in recovery cooldown.", "transient", retryAt);
  }

  if (provider === "apify" && mapsEnv && !recoveryProbe) {
    const now = new Date();
    const [spendToday, priorPacingStates] = await Promise.all([
      getTodaySpendUsd(campaign.workspaceId, "apify", settings.timezone, now),
      getLatestProviderEconomicPacingStates(campaign.workspaceId, settings.timezone, now),
    ]);
    const dailyCap = Math.min(5, mapsEnv.APIFY_DAILY_COST_LIMIT_USD, settings.maxDailyApifySpendUsd ?? Number.POSITIVE_INFINITY);
    const economicPacing = computeProviderBudgetPacing({
      spendTodayUsd: spendToday,
      dailyCapUsd: dailyCap,
      elapsedOperatingFraction: getElapsedOperatingFraction(
        settings.timezone,
        now,
        settings.operatingStartHour ?? 7,
        settings.operatingEndHour ?? 22,
      ),
      previousState: priorPacingStates.apify,
    });
    executionEconomicPaceState = economicPacing.state;
    if (economicPacing.state === "NEAR_DAILY_CAP") {
      if (priorPacingStates.apify !== economicPacing.state) {
        await recordProviderRun({
          workspaceId: campaign.workspaceId,
          provider: "apify",
          operation: "economic_pacing_state",
          status: "completed",
          itemsRequested: 0,
          itemsReturned: 0,
          costUsd: 0,
          metadata: {
            economicPaceState: economicPacing.state,
            spendTodayUsd: economicPacing.spendTodayUsd,
            dailyCapUsd: economicPacing.dailyCapUsd,
            expectedSpendByNowUsd: economicPacing.expectedSpendByNowUsd,
            timePacePct: economicPacing.timePacePct,
          },
        });
      }
      logEvent("info", "discovery.provider.deferred", {
        correlationId: job.id,
        discoveryJobId: job.id,
        provider,
        reason: "economic_near_daily_cap",
        spendTodayUsd: economicPacing.spendTodayUsd,
        dailyCapUsd: economicPacing.dailyCapUsd,
        economicPaceState: economicPacing.state,
      });
      throw new ProviderBudgetExceededError(
        "Apify allocation is paused near the daily budget cap.",
        getDayBounds(settings.timezone, now).end,
      );
    }
  }

  const engine = createDiscoveryEngine(campaign.workspaceId, job.payload.engineType, campaign.id, job.id);
  // Every concrete engine owns a persisted, idempotent seed catalog. Hybrid
  // Fill is intentionally excluded: it routes work to one of these engines
  // rather than creating a duplicate candidate source of its own.
  const catalogSeeds = job.payload.engineType === "hybrid_fill"
    ? []
    : catalogForEngine(campaign, job.payload.engineType);
  if (job.payload.engineType !== "hybrid_fill") {
    await runPreReservationStage(
      job,
      "bootstrap",
      () => bootstrapSearchSeeds(campaign.id, job.payload.engineType, catalogSeeds),
      catalogSeeds,
    );
    logEvent("info", "discovery.seeds.bootstrapped", {
      correlationId: job.id,
      discoveryJobId: job.id,
      engineType: job.payload.engineType,
      catalogSeedCount: catalogSeeds.length,
    });
  }
  const persistedSeeds = await runPreReservationStage(
    job,
    "load_seeds",
    () => listSearchSeedsForCampaignEngine(campaign.id, job.payload.engineType),
    catalogSeeds,
  );
  logEvent("info", "discovery.seeds.loaded", {
    correlationId: job.id,
    discoveryJobId: job.id,
    engineType: job.payload.engineType,
    persistedSeedCount: persistedSeeds.length,
  });
  if ("seeds" in engine) (engine as { seeds: SearchSeed[] }).seeds = persistedSeeds;

  // The first provider run stays deliberately small. Once one terminal
  // success establishes health, a job can use the full five-seed planning
  // window (5 × 100 raw), still subject to the per-workspace daily raw and
  // spend guards in reserveApifyProviderRun.
  const bootstrapCap = getApifyDiscoveryBatchCap(recoveryProbe, providerHealth);
  const desiredRawCount = probeMode
    ? Math.min(5, Math.max(0, Math.floor(job.payload.maxCandidates ?? job.payload.desiredRawCount)))
    : Math.min(bootstrapCap, Math.max(0, Math.floor(job.payload.desiredRawCount)));
  if (desiredRawCount <= 0) return 0;
  const maxSeeds = probeMode ? 1 : Math.min(MAX_SEEDS_PER_JOB, Math.max(1, Math.ceil(desiredRawCount / 10)));
  logEvent("info", "discovery.seeds.planning", {
    correlationId: job.id,
    discoveryJobId: job.id,
    engineType: job.payload.engineType,
    desiredRawCount,
    maxSeeds,
    recoveryProbe,
  });
  const { seeds } = await runPreReservationStage(
    job,
    "plan_batch",
    () => engine.planDiscoveryBatch({ campaignId: campaign.id, remainingTarget: desiredRawCount }),
    persistedSeeds,
  );
  logEvent("info", "discovery.seeds.planned", {
    correlationId: job.id,
    discoveryJobId: job.id,
    engineType: job.payload.engineType,
    plannedSeedCount: seeds.length,
  });
  const requestedSeedSpecified = Boolean(job.payload.seedQuery && job.payload.seedGeography);
  const probeSeed = probeMode ? persistedSeeds.find((seed) => seed.id === job.payload.seedId) : undefined;
  if (probeMode && (!probeSeed || probeSeed.campaignId !== campaign.id || probeSeed.engineType !== job.payload.engineType
    || !probeSeed.query.trim() || !probeSeed.geography.trim()
    || probeSeed.query !== job.payload.seedQuery || probeSeed.geography !== job.payload.seedGeography)) {
    throw new Error("Scoped cold-start seed is not owned by the campaign or is incompatible with its engine.");
  }
  if (probeMode && probeSeed?.nextEligibleAt && new Date(probeSeed.nextEligibleAt).getTime() > Date.now()) {
    throw new Error("Scoped cold-start seed is inside its cooldown window.");
  }
  const candidatePool = probeMode ? persistedSeeds : provider === "apify" ? persistedSeeds : seeds;
  const requestedSeed = probeMode
    ? probeSeed
    : job.payload.seedQuery && job.payload.seedGeography
    ? candidatePool.find((seed) => seed.query === job.payload.seedQuery && seed.geography === job.payload.seedGeography)
    : undefined;
  const seedCandidates = probeMode ? (probeSeed ? [probeSeed] : []) : requestedSeed ? [requestedSeed] : candidatePool;
  const usesSeedEconomics = provider === "apify" || job.payload.engineType === "google_serp";
  const seedEconomics = usesSeedEconomics
    ? await getSeedEconomicPerformance(campaign.id, job.payload.engineType, new Date(), campaign.timeZone)
    : new Map();
  const economicPlan = usesSeedEconomics
    ? planSeedBatches({
      seeds: seedCandidates,
      performanceBySeed: seedEconomics,
      provider,
      rawNeeded: desiredRawCount,
      maxSeeds,
      now: new Date(),
      configuredMaxResults: APIFY_MAX_RESULTS_PER_SEARCH,
      batchCostLimitUsd: Math.min(mapsEnv?.APIFY_BATCH_COST_LIMIT_USD ?? APIFY_DEFAULT_BATCH_COST_LIMIT_USD, APIFY_DEFAULT_BATCH_COST_LIMIT_USD),
      economicPressure: executionEconomicPaceState === "AHEAD_OF_BUDGET_PACE"
        || executionEconomicPaceState === "NEAR_DAILY_CAP",
    })
    : null;
  let economicBatches = economicPlan?.batches ?? [];
  if (probeMode && probeSeed) {
    const probePlan = resolveScopedColdStartBatches({
      probeAuthorized: true,
      seed: probeSeed,
      performance: seedEconomics.get(probeSeed.id),
      existingBatches: economicBatches,
      desiredRawCount,
      now: new Date(),
    });
    economicBatches = probePlan.batches;
    if (probePlan.blockedReason) throw new Error(`Cold-start probe blocked: ${probePlan.blockedReason}.`);
  }
  if (economicPlan) {
    const plannedItems = economicPlan.coreRequestedItems + economicPlan.explorationRequestedItems;
    const tierCounts = Object.fromEntries(["high", "good", "marginal", "low", "zero"].map((tier) => [
      tier,
      economicBatches.filter((batch) => batch.policy.tier === tier).length,
    ]));
    logEvent("info", "discovery.seed_plan_economics", {
      correlationId: job.id,
      discoveryJobId: job.id,
      requestedTarget: desiredRawCount,
      coreRequestedItems: economicPlan.coreRequestedItems,
      explorationRequestedItems: economicPlan.explorationRequestedItems,
      totalPlannedRequestedItems: plannedItems,
      explorationRequestedShare: plannedItems > 0 ? economicPlan.explorationRequestedItems / plannedItems : 0,
      economicPressureActive: executionEconomicPaceState === "AHEAD_OF_BUDGET_PACE"
        || executionEconomicPaceState === "NEAR_DAILY_CAP",
      economicPaceState: executionEconomicPaceState ?? null,
      ...Object.fromEntries(Object.entries(tierCounts).map(([tier, count]) => [`${tier}SeedsRun`, count])),
      explorationSeedsRun: economicBatches.filter((batch) => batch.policy.exploration).length,
      productiveSeedCapacityConstrained: economicPlan.productiveSeedCapacityConstrained,
    });
  }
  const boundedSeeds = probeMode
    ? economicBatches.slice(0, 1).map((batch) => batch.seed)
    : provider === "apify"
    || job.payload.engineType === "google_serp"
    ? economicBatches.map((batch) => batch.seed)
    : seedCandidates.slice(0, maxSeeds);
  const economicBatchBySeed = new Map(economicBatches.map((batch) => [batch.seed.id, batch]));
  const coolingSeedCount = seedCandidates.reduce((count, seed) => {
    const policy = scoreSeedEconomicPerformance(seed, seedEconomics.get(seed.id), new Date());
    return count + (policy.eligible ? 0 : 1);
  }, 0);
  if (coolingSeedCount > 0) {
    logEvent("info", "discovery.seed_low_novelty_cooldown", {
      correlationId: job.id,
      campaignId: campaign.id,
      engineType: job.payload.engineType,
      cooledSeedCount: coolingSeedCount,
    });
  }
  for (const batch of economicBatches) {
    const performance = seedEconomics.get(batch.seed.id);
    const fields = {
      correlationId: job.id,
      campaignId: campaign.id,
      seedId: batch.seed.id,
      engineType: job.payload.engineType,
      sampleSize: performance?.sampleSize ?? 0,
      noveltyRate: performance?.noveltyRate ?? null,
      qualifiedYield: performance?.qualifiedYield ?? null,
      validEmailYield: performance?.validEmailYield ?? null,
      importYield: performance?.confirmedImportYield ?? null,
      costPerNewRaw: performance?.costPerNewRaw ?? null,
      costPerImport: performance?.costPerConfirmedImport ?? null,
      batchSize: batch.requestedItems,
      tier: batch.policy.tier,
    };
    logEvent("info", "discovery.seed_economic_score", fields);
    logEvent("info", "discovery.seed_novelty_tier", fields);
    logEvent("info", "discovery.seed_adaptive_batch", fields);
  }
  logEvent("info", "discovery.seeds.bounded", {
    correlationId: job.id,
    discoveryJobId: job.id,
    boundedSeedCount: boundedSeeds.length,
    requestedSeedSpecified,
    requestedSeedMatchFound: Boolean(requestedSeed),
  });
  if (boundedSeeds.length === 0) {
    logEvent("warn", "discovery.seeds.empty", {
      correlationId: job.id,
      discoveryJobId: job.id,
      engineType: job.payload.engineType,
      plannedSeedCount: seeds.length,
      boundedSeedCount: boundedSeeds.length,
      requestedSeedSpecified,
      requestedSeedMatchFound: Boolean(requestedSeed),
    });
    return 0;
  }
  let remainingRaw = desiredRawCount;

  let totalRawCandidates = 0;
  for (const [seedIndex, seed] of boundedSeeds.entries()) {
    const plannedItems = usesSeedEconomics
      ? economicBatchBySeed.get(seed.id)?.requestedItems ?? 0
      : Math.min(MAX_RAW_PER_SEED, Math.max(1, Math.ceil(remainingRaw / (boundedSeeds.length - seedIndex))));
    const requestedItems = provider === "apify"
      ? resolveApifyMaxResults({
        requestedItems: plannedItems,
        configuredMaxResults: APIFY_MAX_RESULTS_PER_SEARCH,
        batchCostLimitUsd: Math.min(mapsEnv?.APIFY_BATCH_COST_LIMIT_USD ?? APIFY_DEFAULT_BATCH_COST_LIMIT_USD, APIFY_DEFAULT_BATCH_COST_LIMIT_USD),
      })
      : plannedItems;
    if (requestedItems <= 0) continue;
    const startedAt = new Date();
    const reservationFields = {
      correlationId: job.id,
      discoveryJobId: job.id,
      engineType: job.payload.engineType,
      origin: job.payload.origin ?? "normal",
      recoveryProbe,
    };
    if (engine.usesAsyncProvider) {
      logEvent("info", "discovery.provider.reserve.prepare", {
        ...reservationFields,
        stage: "reserve.prepare",
      });
    }
    const planningWindow = resolvePlanningWindow(job.payload.planningWindow, startedAt, campaign.timeZone);
    const normalizedQuery = normalizeProviderQuery(`${seed.query} ${seed.geography}`);
    const requestPlanningWindow = probeMode
      ? `${planningWindow}:scoped-smoke:${job.payload.smokeExecutionId}`
      : planningWindow;
    const requestKey = createProviderRequestKey({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      engineType: job.payload.engineType,
      provider,
      query: normalizedQuery,
      planningWindow: requestPlanningWindow,
    });
    if (engine.usesAsyncProvider) {
      logEvent("info", "discovery.provider.reserve.request_key_created", {
        ...reservationFields,
        stage: "reserve.request_key_created",
      });
    }
    let seedRunId: string | null = null;
    let reservationId: string | null = null;
    let reservationMetadata: Record<string, unknown> = {};
    if (engine.usesAsyncProvider) {
      logEvent("info", "discovery.provider.reserve.provider_run_attempt", {
        ...reservationFields,
        stage: "reserve.provider_run_attempt",
      });
      let reservation;
      try {
        const apiToken = mapsEnv?.APIFY_API_TOKEN;
        if (!apiToken) throw new ProviderConfigurationError("APIFY_API_TOKEN is required to verify the account spend before allocation.");
        const accountDay = getDayBounds("Europe/Madrid", startedAt);
        const accountCostSnapshot = await new ApifyClient({ apiToken }).getAccountCostSnapshot(accountDay.start, accountDay.end);
        reservation = await reserveApifyProviderRun({
          workspaceId: campaign.workspaceId,
          campaignId: campaign.id,
          operation: "maps_search",
          requestKey,
          seedId: seed.id,
          itemsRequested: requestedItems,
          accountCostSnapshot,
          recoveryProbe,
          metadata: {
            engineType: job.payload.engineType,
            seedId: seed.id,
            ...(provider === "apify" && economicBatchBySeed.get(seed.id) ? {
              seedEconomicTier: economicBatchBySeed.get(seed.id)!.policy.tier,
              seedEconomicExploration: economicBatchBySeed.get(seed.id)!.policy.exploration,
              seedEconomicCoreRequestedItems: economicBatchBySeed.get(seed.id)!.policy.exploration ? 0 : requestedItems,
              seedEconomicExplorationRequestedItems: economicBatchBySeed.get(seed.id)!.policy.exploration ? requestedItems : 0,
              productiveSeedCapacityConstrained: economicPlan?.productiveSeedCapacityConstrained ?? false,
            } : {}),
            discoveryJobId: job.id,
            query: seed.query,
            normalizedQuery,
            geography: seed.geography,
            planningWindow,
            recoveryProbe,
            ...(executionEconomicPaceState ? { economicPaceState: executionEconomicPaceState } : {}),
            ...(mapsEnv?.APIFY_API_TOKEN
              ? { credentialFingerprint: createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN) }
              : {}),
            ...(recoveryProbe && apifyConfigurationFingerprint ? { configurationFingerprint: apifyConfigurationFingerprint } : {}),
          },
        });
      } catch (error) {
        const failure = getApifyReservationFailureDetails(error);
        logEvent("error", "discovery.provider.reserve.provider_run_failed", {
          ...reservationFields,
          stage: "reserve.provider_run_failed",
          errorClass: failure?.errorClass ?? getErrorClass(error),
          safeErrorMessage: failure?.safeErrorMessage ?? "Provider reservation failed before its outcome could be resolved.",
          ...(failure ? { failureKind: failure.failureKind } : {}),
          ...(failure?.retryAt ? { retryAt: failure.retryAt.toISOString() } : {}),
        });
        throw error;
      }
      counters.providerReservationsCreated += reservation.created ? 1 : 0;
      counters.providerReservationsSkipped += reservation.created ? 0 : 1;
      logEvent("info", "discovery.provider.reservation", {
        ...reservationFields,
        created: reservation.created,
      });
      if (!reservation.created) {
        logEvent("warn", "discovery.provider.reserve.provider_run_failed", {
          ...reservationFields,
          stage: "reserve.provider_run_failed",
          errorClass: "DuplicateReservation",
          safeErrorMessage: "An idempotent provider-run reservation already exists.",
          failureKind: "DUPLICATE_REQUEST",
        });
        logEvent("info", "discovery.provider.reservation_skipped", {
          correlationId: job.id,
          discoveryJobId: job.id,
          reason: "duplicate_or_existing_request",
        });
        continue;
      }
      reservationId = reservation.providerRun.id;
      reservationMetadata = (reservation.providerRun.metadata ?? {}) as Record<string, unknown>;
      const reconciliation = {
        realSpendUsd: reservationMetadata.apifyRealSpendUsdAtReservation,
        internalSpendUsd: reservationMetadata.apifyInternalRecordedSpendUsdAtReservation,
        deltaUsd: reservationMetadata.apifyReconciliationDeltaUsdAtReservation,
        committedUsd: reservationMetadata.apifyAccountCommittedSpendUsdAtReservation,
      };
      if (Object.values(reconciliation).every((value) => typeof value === "number")) {
        logEvent("info", "apify.cost.reconciliation", {
          correlationId: reservationId,
          workspaceId: campaign.workspaceId,
          providerRunId: reservationId,
          ...reconciliation,
          reservationUsd: reservation.providerRun.costUsd,
          apifyRunCount: reservationMetadata.apifyAccountRunCountAtReservation,
        });
      }
      seedRunId = await insertSearchSeedRun({
        seedId: seed.id,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        rawCount: 0,
        uniqueCount: 0,
        readyCount: 0,
        error: null,
      });
      await updateProviderRun(reservationId, { metadata: mergeApifyProviderRunMetadata(reservationMetadata, {}, {
        engineType: job.payload.engineType,
        seedId: seed.id,
        seedRunId,
        discoveryJobId: job.id,
        query: seed.query,
        normalizedQuery,
        geography: seed.geography,
        planningWindow,
        recoveryProbe,
        ...(mapsEnv?.APIFY_API_TOKEN
          ? { credentialFingerprint: createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN) }
          : {}),
        ...(recoveryProbe && apifyConfigurationFingerprint ? { configurationFingerprint: apifyConfigurationFingerprint } : {}),
      }) });
    }

    let result;
    try {
        result = await engine.executeDiscovery({
          seed,
          dryRun: false,
          requestKey,
          maxResults: probeMode ? Math.min(5, desiredRawCount, requestedItems) : requestedItems,
          planningWindow,
          ...(probeMode ? { maxProviderQueries: 1, probeExecutionId: job.payload.smokeExecutionId } : {}),
        });
        if (probeMode && probeEvidence) {
          const providerQueriesUsed = Math.max(0, Math.floor(result.providerCalls));
          if (providerQueriesUsed > 1) throw new Error("Scoped provider query limit exceeded.");
          probeEvidence.providerQueriesUsed += providerQueriesUsed;
          probeEvidence.providerCallAttempted ||= providerQueriesUsed > 0;
          probeEvidence.providerCallSucceeded = probeEvidence.providerCallAttempted
            && result.providerCallSucceeded !== false && result.providerErrors === 0;
          probeEvidence.providerCallErrorClass = result.providerCallErrorClass ?? null;
          probeEvidence.resultsReturned += Math.max(0, Math.floor(result.resultsReturned ?? result.rawCandidates.length));
        }
    } catch (error) {
        if (probeMode && probeEvidence) {
          const errorQueries = typeof error === "object" && error !== null && "httpAttempts" in error
            && typeof error.httpAttempts === "number"
            ? error.httpAttempts
            : typeof error === "object" && error !== null && "providerCallAttempted" in error
              && error.providerCallAttempted === true
              ? 1
              : 0;
          probeEvidence.providerQueriesUsed = Math.min(1, Math.max(probeEvidence.providerQueriesUsed, errorQueries));
          probeEvidence.providerCallAttempted ||= errorQueries > 0;
          probeEvidence.providerCallSucceeded = false;
          probeEvidence.providerCallErrorClass = error instanceof Error ? error.constructor.name : typeof error;
        }
      const message = error instanceof Error ? error.message : String(error);
      counters.providerStartsFailed += 1;
      const normalizedFailureKind = error instanceof ProviderFailureError
        ? getApifyFailureKind(error) ?? error.kind
        : error instanceof ProviderBudgetExceededError ? error.budgetKind : null;
      const failureClass = getApifyFailureClass(error);
      const retryAt = error instanceof ProviderFailureError || error instanceof ProviderBudgetExceededError
        ? error.retryAt
        : null;
      logEvent("error", "discovery.provider.start_failed", {
        correlationId: job.id,
        discoveryJobId: job.id,
        ...(reservationId ? { providerRunId: reservationId } : {}),
        failureKind: normalizedFailureKind ?? "unknown",
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        retryAt: retryAt?.toISOString() ?? null,
      });
      if (reservationId) {
        const failureKind = normalizedFailureKind;
        const credentialFingerprint = failureKind === "authentication" || failureKind === "billing"
          ? createApifyCredentialFingerprint(getMapsEnv().APIFY_API_TOKEN)
          : null;
        const configurationFingerprint = failureKind === "configuration" ? apifyConfigurationFingerprint : null;
        await updateProviderRun(reservationId, {
          status: "failed",
          finishedAt: new Date(),
          ...getApifyStartupCostPatch(failureKind),
          error: `Provider startup failed: ${message}`,
          metadata: mergeApifyProviderRunMetadata(reservationMetadata, {}, {
            engineType: job.payload.engineType,
            seedId: seed.id,
            seedRunId,
            discoveryJobId: job.id,
            query: seed.query,
            normalizedQuery,
            geography: seed.geography,
            planningWindow,
            recoveryProbe,
            ...(failureKind ? { failureKind } : {}),
            ...(failureClass ? { failureClass } : {}),
            ...(credentialFingerprint ? { credentialFingerprint } : {}),
            ...(configurationFingerprint ? { configurationFingerprint } : {}),
          }),
        });
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
        itemsRequested: result.providerRun.itemsRequested,
        metadata: mergeApifyProviderRunMetadata(
          reservationMetadata,
          result.providerRun.metadata,
          {
            engineType: job.payload.engineType,
            seedId: seed.id,
            seedRunId,
            discoveryJobId: job.id,
            query: seed.query,
            normalizedQuery,
            geography: seed.geography,
            planningWindow,
            recoveryProbe,
          },
        ),
      });
      counters.providerRunsStarted += 1;
      logEvent("info", "discovery.provider.started", {
        correlationId: job.id,
        discoveryJobId: job.id,
        providerRunId: reservationId,
        externalRunIdPresent: Boolean(result.providerRun.externalRunId),
        externalDatasetIdPresent: Boolean(result.providerRun.externalDatasetId),
        providerRunStatus: result.providerRun.status,
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
      rawCount: probeMode ? Math.min(desiredRawCount, result.rawCandidates.length) : result.rawCandidates.length,
      uniqueCount: probeMode ? Math.min(desiredRawCount, result.rawCandidates.length) : result.rawCandidates.length,
      readyCount: 0,
      error: result.providerErrors > 0 ? `${result.providerErrors} provider error(s)` : null,
    });

    const rawCandidates = probeMode ? result.rawCandidates.slice(0, desiredRawCount) : result.rawCandidates;
    const insertedIds =
      rawCandidates.length > 0
        ? await insertRawCandidates(
            rawCandidates.map((candidate) => ({
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
      counters.rawCandidatesInserted += insertedIds.length;
      counters.rawCandidatesDuplicate += rawCandidates.length - insertedIds.length;
    if (probeMode && probeEvidence) {
      probeEvidence.rawCandidatesInserted += insertedIds.length;
      probeEvidence.duplicates += rawCandidates.length - insertedIds.length;
      probeEvidence.candidateCount += insertedIds.length;
    }

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
  rawCandidatesInserted: number;
  rawCandidatesDuplicate: number;
  providerReservationsCreated: number;
  providerReservationsSkipped: number;
  providerRunsStarted: number;
  providerStartsFailed: number;
  providerJobsDeferred: number;
  pausedWorkspaces: number;
  emergencyStoppedWorkspaces: number;
  scopedProbeEvidence?: ScopedProbeEvidence;
}

/** One bounded batch of discovery work across every workspace: enqueue-if-missing per workspace, then a single global claim+execute loop of up to `maxJobsPerTick` jobs (claims are global — not workspace-scoped — so this must not be called once per workspace). Called once per `/api/cron/discovery` invocation. */
export interface ScopedDiscoveryExecution {
  campaignId: string;
  jobId: string;
  allowScopedDraftCampaign: true;
  probeMode?: true;
  smokeExecutionId?: string;
}

export function isAuthorizedScopedProbeExecution(
  scoped: ScopedDiscoveryExecution | undefined,
  job: Pick<JobRecord<DiscoveryJobPayload>, "id" | "campaignId" | "payload">,
): boolean {
  return scoped?.probeMode === true
    && scoped.allowScopedDraftCampaign === true
    && scoped.jobId === job.id
    && scoped.campaignId === job.campaignId
    && scoped.smokeExecutionId === job.id
    && job.payload.probeMode === true
    && job.payload.scopedSmoke === true
    && job.payload.smokeExecutionId === job.id
    && job.payload.maxProviderQueries === 1;
}

export async function runDiscoveryCronTick(
  maxJobsPerTick: number,
  now: Date = new Date(),
  scoped?: ScopedDiscoveryExecution,
): Promise<DiscoveryRunnerResult> {
  const scopedCampaign = scoped ? await getCampaignById(scoped.campaignId) : null;
  if (scoped && (!scopedCampaign || getMultiNicheRolloutEntry(scoped.campaignId)?.niche !== scopedCampaign.engineConfig?.niche)) {
    throw new Error("Scoped discovery campaign is not allowlisted.");
  }
  const workspaceIds = scoped ? [scopedCampaign!.workspaceId] : await listWorkspaceIds();
  if (scoped?.probeMode && (!scoped.smokeExecutionId || scoped.jobId !== scoped.smokeExecutionId
    || !getMultiNicheRolloutEntry(scoped.campaignId))) {
    throw new Error("Scoped probe authorization must match the allowlisted campaign and execution job.");
  }
  if (!scoped) {
    for (const workspaceId of workspaceIds) await ensureDiscoveryJobsQueued(workspaceId);
  }

  const workerId = `cron-discovery-${randomUUID()}`;
  let jobsClaimed = 0;
  let rawCandidatesProduced = 0;
  const handoffCounters: DiscoveryHandoffCounters = {
    providerReservationsCreated: 0,
    providerReservationsSkipped: 0,
    providerRunsStarted: 0,
    providerStartsFailed: 0,
    providerJobsDeferred: 0,
    rawCandidatesInserted: 0,
    rawCandidatesDuplicate: 0,
  };
  let pausedWorkspaces = 0;
  let emergencyStoppedWorkspaces = 0;
  const scopedProbeEvidence: ScopedProbeEvidence | undefined = scoped?.probeMode ? {
    jobClaimed: false,
    providerCallAttempted: false,
    providerCallSucceeded: false,
    providerCallErrorClass: null,
    providerQueriesUsed: 0,
    resultsReturned: 0,
    rawCandidatesInserted: 0,
    duplicates: 0,
    candidateCount: 0,
  } : undefined;

  const jobs = await claimDiscoveryJobs<DiscoveryJobPayload>({
    workerId,
    batchSize: scoped ? 1 : maxJobsPerTick,
    now,
    ...(scoped ? {
      campaignId: scoped.campaignId,
      jobId: scoped.jobId,
      requireAutopilot: false,
      allowScopedDraftCampaign: scoped.allowScopedDraftCampaign,
    } : { allowWatchdogRecovery: true }),
  });
  for (const job of jobs) {
    jobsClaimed += 1;
    if (scopedProbeEvidence) scopedProbeEvidence.jobClaimed = true;
    try {
      rawCandidatesProduced += await executeDiscoveryJob(
        job,
        handoffCounters,
        isAuthorizedScopedProbeExecution(scoped, job),
        scopedProbeEvidence,
        scoped?.smokeExecutionId,
      );
      if (scopedProbeEvidence) {
        scopedProbeEvidence.rawCandidatesInserted = handoffCounters.rawCandidatesInserted;
        scopedProbeEvidence.duplicates = handoffCounters.rawCandidatesDuplicate;
        scopedProbeEvidence.candidateCount = handoffCounters.rawCandidatesInserted;
        await persistScopedSmokeEvidence({ jobId: job.id, workerId, evidence: scopedProbeEvidence });
      }
      await completeDiscoveryJob({ jobId: job.id, workerId, now });
    } catch (error) {
      if (scopedProbeEvidence) {
        scopedProbeEvidence.providerCallErrorClass ??= error instanceof Error ? error.constructor.name : typeof error;
        try {
          await persistScopedSmokeEvidence({ jobId: job.id, workerId, evidence: scopedProbeEvidence });
        } catch {
          logEvent("error", "discovery.scoped_probe.evidence_persist_failed", {
            correlationId: job.id,
            campaignId: job.campaignId,
          });
        }
      }
      const failureKind = error instanceof ProviderFailureError
        ? getApifyFailureKind(error) ?? error.kind
        : error instanceof ProviderBudgetExceededError ? error.budgetKind : undefined;
      const retryAt = error instanceof ProviderFailureError || error instanceof ProviderBudgetExceededError
        ? error.retryAt
        : null;
      logEvent("error", "discovery.job.failed", {
        correlationId: job.id,
        discoveryJobId: job.id,
        engineType: job.payload.engineType,
        origin: job.payload.origin ?? null,
        errorClass: getErrorClass(error),
        ...(failureKind ? { failureKind } : {}),
        ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
      });
      if (job.payload.origin === "recovery_probe") {
        logEvent("error", "apify.recovery_probe_failed", {
          correlationId: job.id,
          discoveryJobId: job.id,
          failureKind: failureKind ?? "provider_error",
        });
      }
      if (error instanceof ProviderBudgetExceededError) {
        handoffCounters.providerJobsDeferred += 1;
        await deferDiscoveryJob({ jobId: job.id, workerId, nextAttemptAt: error.retryAt, reason: error.message });
      } else if (error instanceof ProviderFailureError && error.retryAt) {
        handoffCounters.providerJobsDeferred += 1;
        await deferDiscoveryJob({ jobId: job.id, workerId, nextAttemptAt: getProviderFailureRetryAt(error, now)!, reason: error.message });
      } else if (error instanceof ProviderConfigurationError) {
        await failDiscoveryJob({ workerId, job, error, now, classification: "permanent" });
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
  return {
    jobsClaimed,
    rawCandidatesProduced,
    ...handoffCounters,
    pausedWorkspaces,
    emergencyStoppedWorkspaces,
    ...(scopedProbeEvidence ? { scopedProbeEvidence } : {}),
  };
}
