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
}

export interface EngineCapabilityInput {
  mapsProvider: "apify" | "mock";
  serpProvider: "serper" | "disabled" | "mock";
  mapsFastHealth: ProviderHealthStatus;
  costAllowed: boolean;
  campaignCounts: Partial<Record<EngineType, number>>;
}

export function buildEngineCapabilities(input: EngineCapabilityInput): EngineCapability[] {
  const definitions: Array<[EngineType, boolean, boolean, ProviderHealthStatus]> = [
    ["maps_fast", input.mapsProvider === "apify", true, input.mapsFastHealth],
    ["maps_deep", false, false, "paused"],
    ["google_serp", input.serpProvider === "serper", input.serpProvider === "serper", "paused"],
    ["linkedin_owner", input.serpProvider === "serper", input.serpProvider === "serper", "paused"],
    ["hybrid_fill", false, true, input.mapsFastHealth],
  ];

  return definitions.map(([engineType, providerConfigured, providerHealthyByConfig, health]) => {
    const campaignCount = input.campaignCounts[engineType] ?? 0;
    const providerUntested = providerHealthyByConfig && health === "untested";
    const providerHealthy = providerHealthyByConfig && (health === "healthy" || providerUntested);
    const available = engineType === "hybrid_fill"
      ? input.mapsProvider === "apify" && providerHealthy && input.costAllowed
      : providerConfigured && providerHealthy && input.costAllowed && campaignCount > 0;
    return {
      engineType,
      available,
      providerConfigured,
      providerHealthy,
      providerUntested,
      costAllowed: input.costAllowed,
      campaignCount,
      reasonUnavailable: available
        ? null
        : !providerConfigured
          ? "provider_not_configured"
          : !providerHealthy
            ? `provider_${health}`
            : !input.costAllowed
              ? "budget_exhausted"
              : campaignCount === 0 && engineType !== "hybrid_fill"
                ? "no_active_campaign"
                : null,
    } satisfies EngineCapability;
  });
}