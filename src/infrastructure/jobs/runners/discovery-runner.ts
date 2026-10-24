import { randomUUID } from "node:crypto";
import type { EngineType } from "@/domain/campaigns/types";
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
import { getApifyRecoverySnapshot, getApifyReservationFailureDetails, getRecentProviderUsage, reserveApifyProviderRun, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, LINKEDIN_OWNER_ROLE_QUERIES, ICP_CATEGORY_TERMS } from "@/services/discovery/spain-search-catalog";
import { createDiscoveryEngine } from "./engine-factory";
import type { SearchSeed } from "@/domain/discovery/types";
import { createApifyConfigurationFingerprint, createApifyCredentialFingerprint, evaluateProviderHealth, getApifyAllocationHealth, isCurrentApifyRecoveryCredential, resolveApifyDiscoveryWorkMode } from "@/services/discovery/provider-health";
import { createProviderRequestKey, normalizeProviderQuery } from "@/services/discovery/provider-request-key";
import { resolvePlanningWindow } from "@/services/autopilot/target-planner";
import { getMapsEnv } from "@/lib/config/env";
import { logEvent } from "@/lib/observability/structured-logger";
import { getApifyFailureClass, getApifyFailureKind } from "@/infrastructure/providers/maps/apify-client";

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
  origin?: "normal" | "rebalance" | "hybrid_fill" | "recovery_probe";
  recoveryCredentialFingerprint?: string;
  seedQuery?: string;
  seedGeography?: string;
}

type PreReservationStage = "bootstrap" | "load_seeds" | "plan_batch";

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

async function executeDiscoveryJob(
  job: { id: string; campaignId: string; payload: DiscoveryJobPayload },
  counters: DiscoveryHandoffCounters,
): Promise<number> {
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
    if (currentCampaign.status !== "active" || !currentCampaign.autopilotEnabled) {
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
  if (autopilotState !== "running") return 0;

  const provider = job.payload.engineType === "maps_fast" || job.payload.engineType === "maps_deep" ? "apify" : "serper";
  const mapsEnv = provider === "apify"
    ? await runPreProviderStage(job, "load_maps_env", () => getMapsEnv())
    : null;
  const apifyConfigurationFingerprint = mapsEnv
    ? await runPreProviderStage(job, "create_configuration_fingerprint", () => createApifyConfigurationFingerprint(mapsEnv))
    : null;
  const apifyRecovery = provider === "apify"
    ? await runPreProviderStage(job, "load_apify_recovery_snapshot", () => getApifyRecoverySnapshot(campaign.workspaceId))
    : null;
  const providerHealth = apifyRecovery
    ? await runPreProviderStage(job, "resolve_apify_allocation_health", () => getApifyAllocationHealth(apifyRecovery))
    : evaluateProviderHealth(await getRecentProviderUsage(campaign.workspaceId, provider));
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

  const engine = createDiscoveryEngine(campaign.workspaceId, job.payload.engineType, campaign.id, job.id);
  // Every concrete engine owns a persisted, idempotent seed catalog. Hybrid
  // Fill is intentionally excluded: it routes work to one of these engines
  // rather than creating a duplicate candidate source of its own.
  const catalogSeeds = job.payload.engineType === "hybrid_fill"
    ? []
    : catalogForEngine(campaign.id, job.payload.engineType);
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
  const desiredRawCount = Math.min(bootstrapCap, Math.max(0, Math.floor(job.payload.desiredRawCount)));
  if (desiredRawCount <= 0) return 0;
  const maxSeeds = Math.min(MAX_SEEDS_PER_JOB, Math.max(1, Math.ceil(desiredRawCount / 10)));
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
  const requestedSeed = job.payload.seedQuery && job.payload.seedGeography
    ? seeds.find((seed) => seed.query === job.payload.seedQuery && seed.geography === job.payload.seedGeography)
    : undefined;
  const boundedSeeds = requestedSeed ? [requestedSeed] : seeds.slice(0, maxSeeds);
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
    const requestedItems = Math.min(MAX_RAW_PER_SEED, Math.max(1, Math.ceil(remainingRaw / (boundedSeeds.length - seedIndex))));
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
    const requestKey = createProviderRequestKey({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      engineType: job.payload.engineType,
      provider,
      query: normalizedQuery,
      planningWindow,
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
        reservation = await reserveApifyProviderRun({
          workspaceId: campaign.workspaceId,
          campaignId: campaign.id,
          operation: "maps_search",
          requestKey,
          seedId: seed.id,
          itemsRequested: requestedItems,
          recoveryProbe,
          metadata: {
            engineType: job.payload.engineType,
            seedId: seed.id,
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
      result = await engine.executeDiscovery({ seed, dryRun: false, requestKey, maxResults: requestedItems, planningWindow });
    } catch (error) {
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
        costUsd: result.providerRun.costUsd,
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
      counters.rawCandidatesInserted += insertedIds.length;
      counters.rawCandidatesDuplicate += result.rawCandidates.length - insertedIds.length;

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

  const jobs = await claimDiscoveryJobs<DiscoveryJobPayload>({ workerId, batchSize: maxJobsPerTick, now });
  for (const job of jobs) {
    jobsClaimed += 1;
    try {
      rawCandidatesProduced += await executeDiscoveryJob(job, handoffCounters);
      await completeDiscoveryJob({ jobId: job.id, workerId, now });
    } catch (error) {
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
  return { jobsClaimed, rawCandidatesProduced, ...handoffCounters, pausedWorkspaces, emergencyStoppedWorkspaces };
}
