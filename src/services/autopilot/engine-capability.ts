import type { EngineType } from "@/domain/campaigns/types";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";

export interface EngineCapability {
  engineType: EngineType;
  available: boolean;
  providerConfigured: boolean;
  providerHealthy: boolean;
  providerUntested: boolean;
  costAllowed: boolean;
  campaignCount: number;
  reasonUnavailable: string | null;
  /** Human-readable alias used by the Autopilot and campaign UI. */
  reason: string | null;
}

export interface EngineCapabilityInput {
  mapsProvider: "apify" | "mock";
  mapsProviderConfigured: boolean;
  serpProvider: "serper" | "disabled" | "mock";
  serpProviderConfigured?: boolean;
  mapsFastHealth: ProviderHealthStatus;
  providerHealth?: Partial<Record<EngineType, ProviderHealthStatus>>;
  costAllowed: boolean;
  mapsCostAllowed?: boolean;
  serperCostAllowed?: boolean;
  campaignCounts: Partial<Record<EngineType, number>>;
}

export function buildEngineCapabilities(input: EngineCapabilityInput): EngineCapability[] {
  const mapsConfigured = input.mapsProvider === "apify" && input.mapsProviderConfigured;
  const serpConfigured = input.serpProvider === "serper" && (input.serpProviderConfigured ?? true);
  const health = (engineType: EngineType): ProviderHealthStatus => input.providerHealth?.[engineType]
    ?? (engineType === "maps_fast" ? input.mapsFastHealth : engineType === "maps_deep" ? input.mapsFastHealth : serpConfigured ? "untested" : "paused");
  const mapsCostAllowed = input.mapsCostAllowed ?? input.costAllowed;
  const serperCostAllowed = input.serperCostAllowed ?? input.costAllowed;
  const definitions: Array<[EngineType, boolean, ProviderHealthStatus, boolean]> = [
    ["maps_fast", mapsConfigured, health("maps_fast"), mapsCostAllowed],
    // The existing deep engine calls both the Maps and public SERP adapters.
    ["maps_deep", mapsConfigured && serpConfigured, health("maps_deep"), mapsCostAllowed && serperCostAllowed],
    ["google_serp", serpConfigured, health("google_serp"), serperCostAllowed],
    ["linkedin_owner", serpConfigured, health("linkedin_owner"), serperCostAllowed],
    // Hybrid Fill is an orchestrator. It is available only if at least one
    // concrete discovery provider can actually execute its selected work.
    ["hybrid_fill", mapsConfigured || serpConfigured, health("hybrid_fill"), mapsCostAllowed || serperCostAllowed],
  ];

  return definitions.map(([engineType, providerConfigured, providerStatus, engineCostAllowed]) => {
    const campaignCount = input.campaignCounts[engineType] ?? 0;
    const providerUntested = providerConfigured && providerStatus === "untested";
    const providerHealthy = providerConfigured && (providerStatus === "healthy" || providerUntested);
    const available = providerConfigured && providerHealthy && engineCostAllowed && campaignCount > 0;
    const reasonUnavailable = available
      ? null
      : !providerConfigured
        ? "provider_not_configured"
        : !providerHealthy
          ? `provider_${providerStatus}`
          : !engineCostAllowed
            ? "budget_exhausted"
            : "no_active_campaign";
    return {
      engineType,
      available,
      providerConfigured,
      providerHealthy,
      providerUntested,
      costAllowed: engineCostAllowed,
      campaignCount,
      reasonUnavailable,
      reason: reasonUnavailable,
    } satisfies EngineCapability;
  });
}
