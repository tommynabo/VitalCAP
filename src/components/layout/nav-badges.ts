import type { EngineHealthSummary } from "@/services/discovery/provider-health";

/**
 * Actionable-count badges for the sidebar (Prompt 5 §5.1 "numeric badges for
 * actionable counts"). Pure function over already-fetched data — kept
 * separate from `nav-config.ts` so that module can stay a pure route/icon
 * catalog, and separate from any data source (seed vs Neon) so the caller
 * (the dashboard layout) decides where the data comes from.
 */
export function computeNavBadgeCounts(data: {
  pendingReviewCount: number;
  engineHealthSummary: EngineHealthSummary;
  infrastructureAlertCount: number;
}): Record<string, number> {
  const degradedEngines = data.engineHealthSummary.unhealthyCount;

  return {
    "/reviews": data.pendingReviewCount,
    "/autopilot": degradedEngines,
    "/infrastructure": data.infrastructureAlertCount,
  };
}

