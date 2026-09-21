import {
  seedConversations,
  seedEngineTargets,
  seedMailboxes,
  seedSendingDomains,
} from "@/lib/seed/dev-seed";

/**
 * Actionable-count badges for the sidebar (Prompt 5 §5.1 "numeric badges for
 * actionable counts"). Kept separate from `nav-config.ts` so that module can
 * stay a pure route/icon catalog with no seed-data dependency.
 */
export function getNavBadgeCounts(): Record<string, number> {
  const pendingReviews = seedConversations.filter((c) => c.state === "pending_review").length;
  const degradedEngines = seedEngineTargets.filter((e) => e.providerHealth === "degraded" || e.providerHealth === "paused").length;
  const infrastructureAlerts =
    seedSendingDomains.filter((d) => d.status === "degraded" || d.status === "paused").length +
    seedMailboxes.filter((m) => m.pausedReason).length;

  return {
    "/reviews": pendingReviews,
    "/autopilot": degradedEngines,
    "/infrastructure": infrastructureAlerts,
  };
}
