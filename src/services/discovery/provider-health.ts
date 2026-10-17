import { createHash } from "node:crypto";
import type { EngineType } from "@/domain/campaigns/types";
import type { ProviderUsageStats } from "@/domain/providers/types";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";

/**
 * Provider credit guards (Prompt 2 §2.13). Aggregates raw per-call usage
 * into a health verdict so an engine (or the Autopilot Target Engine) can
 * decide to pause an unhealthy/depleted adapter before burning further
 * downstream work on records that can't complete.
 */

export interface ProviderHealthThresholds {
  /** Error rate at/above which a provider is degraded (still used, but deprioritized). */
  degradedErrorRate: number;
  /** Error rate at/above which a provider is paused entirely. */
  pausedErrorRate: number;
  /** Minimum call count before an error-rate judgement is trusted — a single failed call must not pause a provider. */
  minCallsForJudgement: number;
}

export const APIFY_RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;

export function createApifyCredentialFingerprint(token: string | null | undefined): string | null {
  return token ? createHash("sha256").update(token).digest("hex") : null;
}

export function createApifyConfigurationFingerprint(configuration: {
  APIFY_BATCH_COST_LIMIT_USD: number;
  APIFY_MAPS_FAST_ACTOR: string;
  APIFY_MAPS_DEEP_ACTOR: string;
  APIFY_MAPS_FALLBACK_ACTOR: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    configuration.APIFY_BATCH_COST_LIMIT_USD,
    configuration.APIFY_MAPS_FAST_ACTOR,
    configuration.APIFY_MAPS_DEEP_ACTOR,
    configuration.APIFY_MAPS_FALLBACK_ACTOR,
  ])).digest("hex");
}

export interface ApifyRecoveryRun {
  status: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  itemsReturned: number;
  costUsd: number;
  recoveryProbe?: boolean;
  failureKind?: "transient" | "billing" | "authentication" | "configuration" | "safety";
  credentialFingerprint?: string;
  configurationFingerprint?: string;
}

export interface ApifyRecoverySnapshot {
  usage: ProviderUsageStats;
  recoveryProbeEligible: boolean;
  nextRecoveryAttemptAt: Date | null;
}

export type ApifyDiscoveryWorkMode = "normal" | "recovery_probe" | "defer" | "skip";

export function getApifyAllocationHealth(snapshot: ApifyRecoverySnapshot): ProviderHealthStatus {
  return snapshot.recoveryProbeEligible || snapshot.nextRecoveryAttemptAt !== null
    ? "paused"
    : evaluateProviderHealth(snapshot.usage);
}

export function resolveApifyDiscoveryWorkMode(input: {
  providerHealth: ProviderHealthStatus;
  recoveryProbeEligible: boolean;
  recoveryProbeRequested: boolean;
}): ApifyDiscoveryWorkMode {
  if (input.recoveryProbeEligible) return input.recoveryProbeRequested ? "recovery_probe" : "skip";
  if (input.providerHealth === "paused") return "defer";
  return input.recoveryProbeRequested ? "skip" : "normal";
}

function runDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function evaluateApifyRecovery(
  recentRuns: readonly ApifyRecoveryRun[],
  latestFailure: ApifyRecoveryRun | null,
  latestSuccessAt: Date | string | null,
  recoveryProbeInFlight: boolean,
  blockedBySafetyGate: boolean,
  now = new Date(),
  currentCredentialFingerprint: string | null = null,
  currentConfigurationFingerprint: string | null = null,
): ApifyRecoverySnapshot {
  const emptyUsage: ProviderUsageStats = { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null };
  const successAt = runDate(latestSuccessAt);
  const failureAt = latestFailure ? runDate(latestFailure.finishedAt) ?? runDate(latestFailure.startedAt) : null;
  const successAfterFailure = successAt !== null && failureAt !== null && successAt > failureAt;
  const usageRuns = successAfterFailure
    ? recentRuns.filter((run) => (runDate(run.finishedAt)?.getTime() ?? runDate(run.startedAt)?.getTime() ?? 0) >= successAt.getTime())
    : recentRuns;
  const usage: ProviderUsageStats = {
    calls: 0,
    items: 0,
    errors: 0,
    totalLatencyMs: 0,
    costUsd: 0,
    quotaRemaining: null,
  };
  for (const run of usageRuns) {
    if (!["succeeded", "ingested", "completed", "failed", "aborted", "timed_out"].includes(run.status)) continue;
    usage.calls += 1;
    usage.items += run.itemsReturned;
    usage.costUsd += run.costUsd;
    if (["failed", "aborted", "timed_out"].includes(run.status)) usage.errors += 1;
  }

  const providerPaused = evaluateProviderHealth(usage) === "paused" || (latestFailure !== null && !successAfterFailure);
  if (!latestFailure || successAfterFailure || blockedBySafetyGate) {
    return { usage, recoveryProbeEligible: false, nextRecoveryAttemptAt: null };
  }

  if (latestFailure.failureKind === "configuration") {
    const configurationChanged = currentConfigurationFingerprint !== null
      && latestFailure.configurationFingerprint !== currentConfigurationFingerprint;
    if (!configurationChanged || recoveryProbeInFlight) {
      return { usage, recoveryProbeEligible: false, nextRecoveryAttemptAt: null };
    }
    return { usage: emptyUsage, recoveryProbeEligible: true, nextRecoveryAttemptAt: new Date(now) };
  }

  if (!providerPaused) return { usage, recoveryProbeEligible: false, nextRecoveryAttemptAt: null };

  const credentialRecoverableFailure = latestFailure.failureKind === "authentication"
    || latestFailure.failureKind === "billing";
  const credentialChanged = credentialRecoverableFailure
    && currentCredentialFingerprint !== null
    && latestFailure.credentialFingerprint !== currentCredentialFingerprint;
  const cooldownMs = credentialChanged
    ? 0
    : latestFailure.failureKind === "authentication"
    ? 6 * 60 * 60 * 1000
    : latestFailure.failureKind === "safety"
      ? 60 * 60 * 1000
      : APIFY_RECOVERY_COOLDOWN_MS;
  const nextRecoveryAttemptAt = failureAt ? new Date(failureAt.getTime() + cooldownMs) : null;
  if (!nextRecoveryAttemptAt || now < nextRecoveryAttemptAt || recoveryProbeInFlight) {
    return {
      usage,
      recoveryProbeEligible: false,
      nextRecoveryAttemptAt: recoveryProbeInFlight && nextRecoveryAttemptAt && nextRecoveryAttemptAt <= now
        ? new Date(now.getTime() + 5 * 60 * 1000)
        : nextRecoveryAttemptAt,
    };
  }

  return { usage: emptyUsage, recoveryProbeEligible: true, nextRecoveryAttemptAt };
}

export const DEFAULT_PROVIDER_HEALTH_THRESHOLDS: ProviderHealthThresholds = {
  degradedErrorRate: 0.2,
  pausedErrorRate: 0.5,
  minCallsForJudgement: 3,
};

export function evaluateProviderHealth(
  usage: ProviderUsageStats,
  options: Partial<ProviderHealthThresholds> = {},
): ProviderHealthStatus {
  const opts = { ...DEFAULT_PROVIDER_HEALTH_THRESHOLDS, ...options };

  if (usage.quotaRemaining !== null && usage.quotaRemaining <= 0) return "paused";
  if (usage.calls < opts.minCallsForJudgement) return usage.calls === 0 ? "untested" : "healthy";

  const errorRate = usage.errors / usage.calls;
  if (errorRate >= opts.pausedErrorRate) return "paused";
  if (errorRate >= opts.degradedErrorRate) return "degraded";
  return "healthy";
}

export function accumulateUsage(base: ProviderUsageStats, next: ProviderUsageStats): ProviderUsageStats {
  return {
    calls: base.calls + next.calls,
    items: base.items + next.items,
    errors: base.errors + next.errors,
    totalLatencyMs: base.totalLatencyMs + next.totalLatencyMs,
    costUsd: base.costUsd + next.costUsd,
    quotaRemaining: next.quotaRemaining ?? base.quotaRemaining,
  };
}

export function isProviderAvailableForDiscovery(
  configured: boolean,
  health: ProviderHealthStatus,
  budgetRemaining: number,
  minimumBudgetUsd = 0,
): boolean {
  return configured
    && (health === "healthy" || health === "untested")
    && budgetRemaining > 0
    && budgetRemaining >= minimumBudgetUsd;
}

export interface EngineProviderUsage {
  engineType: EngineType;
  usage: ProviderUsageStats;
}

export interface EngineHealthSummary {
  unhealthyCount: number;
  totalCount: number;
}

export interface ProviderUsageAggregate {
  calls: number;
  errors: number;
}

export const ENGINE_TYPES = ["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"] as const satisfies readonly EngineType[];

export function engineProviderHealthForType(
  engineType: EngineType,
  maps: ProviderHealthStatus,
  serp: ProviderHealthStatus,
): ProviderHealthStatus {
  if (engineType === "maps_fast") return maps;
  if (engineType === "google_serp" || engineType === "linkedin_owner") return serp;
  if (engineType === "maps_deep") {
    if (maps === "paused" || serp === "paused") return "paused";
    if (maps === "degraded" || serp === "degraded") return "degraded";
    return maps === "untested" || serp === "untested" ? "untested" : "healthy";
  }
  if (maps === "healthy" || serp === "healthy" || maps === "untested" || serp === "untested") return "healthy";
  return maps === "degraded" || serp === "degraded" ? "degraded" : "paused";
}

export function summarizeEngineHealthStatuses(statuses: readonly ProviderHealthStatus[]): EngineHealthSummary {
  return {
    unhealthyCount: statuses.filter((status) => status === "degraded" || status === "paused").length,
    totalCount: statuses.length,
  };
}

export function computeEngineHealthSummary(input: {
  mapsConfigured: boolean;
  serpConfigured: boolean;
  mapsUsage: ProviderUsageAggregate;
  serpUsage: ProviderUsageAggregate;
}): EngineHealthSummary {
  const healthFor = (configured: boolean, usage: ProviderUsageAggregate): ProviderHealthStatus => configured
    ? evaluateProviderHealth({
      calls: usage.calls,
      errors: usage.errors,
      items: 0,
      totalLatencyMs: 0,
      costUsd: 0,
      quotaRemaining: null,
    })
    : "paused";
  const maps = healthFor(input.mapsConfigured, input.mapsUsage);
  const serp = healthFor(input.serpConfigured, input.serpUsage);
  return summarizeEngineHealthStatuses(ENGINE_TYPES.map((engineType) => engineProviderHealthForType(engineType, maps, serp)));
}

export function hasUnavailableRequiredDiscoveryProvider(
  engineTypes: readonly EngineType[],
  mapsConfigured: boolean,
  serpConfigured: boolean,
): boolean {
  return engineTypes.some((engineType) => {
    if (engineType === "maps_fast") return !mapsConfigured;
    if (engineType === "maps_deep") return !mapsConfigured || !serpConfigured;
    if (engineType === "google_serp" || engineType === "linkedin_owner") return !serpConfigured;
    return !mapsConfigured && !serpConfigured;
  });
}
