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
