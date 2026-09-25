import type { Conversation } from "@/domain/conversations/types";
import type { EngineTargetState } from "@/domain/autopilot/types";
import type { SendingDomain, Mailbox } from "@/domain/outreach/types";

/**
 * Actionable-count badges for the sidebar (Prompt 5 §5.1 "numeric badges for
 * actionable counts"). Pure function over already-fetched data — kept
 * separate from `nav-config.ts` so that module can stay a pure route/icon
 * catalog, and separate from any data source (seed vs Neon) so the caller
 * (the dashboard layout) decides where the data comes from.
 */
export function computeNavBadgeCounts(data: {
  conversations: Conversation[];
  engineTargets: EngineTargetState[];
  sendingDomains: SendingDomain[];
  mailboxes: Mailbox[];
}): Record<string, number> {
  const pendingReviews = data.conversations.filter((c) => c.state === "pending_review").length;
  const degradedEngines = data.engineTargets.filter(
    (e) => e.providerHealth === "degraded" || e.providerHealth === "paused",
  ).length;
  const infrastructureAlerts =
    data.sendingDomains.filter((d) => d.status === "degraded" || d.status === "paused").length +
    data.mailboxes.filter((m) => m.pausedReason).length;

  return {
    "/reviews": pendingReviews,
    "/autopilot": degradedEngines,
    "/infrastructure": infrastructureAlerts,
  };
}

