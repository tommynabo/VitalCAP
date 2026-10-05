import type { ContactPointType } from "@/domain/contacts/types";
import type { OutreachEventState } from "@/domain/outreach/types";

export interface OutreachAttemptContext {
  contactPointId: string;
  accountId: string;
  campaignId: string;
  channel: ContactPointType;
  now: string;
  normalizedEmail?: string | null;
  hasActiveConversation?: boolean;
  hasMeetingBooked?: boolean;
}

export interface RecentOutreachEvent {
  contactPointId: string;
  accountId: string;
  campaignId: string;
  channel: ContactPointType;
  createdAt: string;
  state: OutreachEventState;
  deliveryMode: "dry_run" | "live";
  providerConfirmed: boolean;
  normalizedEmail?: string | null;
}

export interface OutreachDeliveryHistory {
  deliveryMode: "dry_run" | "live";
  queueState: OutreachEventState;
  eventStates: readonly OutreachEventState[];
}

export interface SuppressionCheckEntry {
  contactPointId: string | null;
  accountId: string | null;
  normalizedEmail?: string | null;
}

export interface OutreachDedupOptions {
  cooldownHours: number;
  /** Non-negotiable #11: never contact several endpoints at the same account simultaneously by default. */
  allowSimultaneousAccountContacts: boolean;
  /** Recontact is opt-in; absent policy means any prior cold outreach blocks re-entry. */
  recontactPolicy: { eligibleAfter?: string; cooldownHours?: number; neverContactAgain?: boolean } | null;
}

export const DEFAULT_OUTREACH_DEDUP_OPTIONS: OutreachDedupOptions = {
  cooldownHours: 24 * 14,
  allowSimultaneousAccountContacts: false,
  recontactPolicy: null,
};

export type OutreachDedupReason =
  | "suppressed"
  | "cooldown_active"
  | "account_concurrency_lock"
  | "existing_outreach"
  | "active_conversation"
  | "meeting_booked";

export interface OutreachDedupDecision {
  allowed: boolean;
  reason: OutreachDedupReason | null;
}

/** States considered "in flight" — awaiting an outcome before a fallback contact point may be tried. */
const IN_FLIGHT_STATES: readonly OutreachEventState[] = ["queued", "scheduled", "provider_submitted", "sent", "delivered"];
export const ACTUAL_PRIOR_COLD_OUTREACH_STATES: readonly OutreachEventState[] = [
  "provider_submitted",
  "sent",
  "delivered",
  "replied",
];

export function hasActualPriorColdOutreach(history: OutreachDeliveryHistory): boolean {
  return (history.deliveryMode === "live" && ACTUAL_PRIOR_COLD_OUTREACH_STATES.includes(history.queueState))
    || history.eventStates.some((state) => ACTUAL_PRIOR_COLD_OUTREACH_STATES.includes(state));
}

export function isDryRunOnlyOutreach(history: OutreachDeliveryHistory): boolean {
  return history.deliveryMode === "dry_run" && !hasActualPriorColdOutreach(history);
}

/**
 * Decides whether a new outreach attempt may be queued (Prompt 1 §1.2
 * outreach dedup). Order matters: suppression always wins, then per-endpoint
 * cooldown, then account-level concurrency (contact the highest-priority
 * eligible endpoint first and wait for an outcome before trying a fallback).
 */
export function canEnterColdOutreach(
  context: OutreachAttemptContext,
  recentEvents: readonly RecentOutreachEvent[],
  suppressionEntries: readonly SuppressionCheckEntry[],
  options: Partial<OutreachDedupOptions> = {},
): OutreachDedupDecision {
  const opts = { ...DEFAULT_OUTREACH_DEDUP_OPTIONS, ...options };

  const isSuppressed = suppressionEntries.some(
    (entry) => entry.contactPointId === context.contactPointId
      || entry.accountId === context.accountId
      || (!!context.normalizedEmail && entry.normalizedEmail === context.normalizedEmail),
  );
  if (isSuppressed) return { allowed: false, reason: "suppressed" };
  if (context.hasActiveConversation) return { allowed: false, reason: "active_conversation" };
  if (context.hasMeetingBooked) return { allowed: false, reason: "meeting_booked" };

  const relevantRecentEvents = recentEvents.filter((event) =>
    event.deliveryMode === "live"
      || (event.providerConfirmed && ACTUAL_PRIOR_COLD_OUTREACH_STATES.includes(event.state)),
  );

  if (!opts.allowSimultaneousAccountContacts) {
    const otherEndpointInFlight = relevantRecentEvents.some(
      (event) =>
        event.accountId === context.accountId &&
        event.contactPointId !== context.contactPointId &&
        IN_FLIGHT_STATES.includes(event.state),
    );
    if (otherEndpointInFlight) return { allowed: false, reason: "account_concurrency_lock" };
  }

  const cooldownMs = opts.cooldownHours * 60 * 60 * 1000;
  const nowMs = new Date(context.now).getTime();

  const sameEndpointEvents = relevantRecentEvents.filter(
    (event) =>
      event.contactPointId === context.contactPointId ||
      event.accountId === context.accountId ||
      (!!context.normalizedEmail && event.normalizedEmail === context.normalizedEmail),
  );
  if (sameEndpointEvents.length > 0) {
    const policy = opts.recontactPolicy;
    if (!policy || policy.neverContactAgain) return { allowed: false, reason: "existing_outreach" };
    const latestEventMs = Math.max(...sameEndpointEvents.map((event) => new Date(event.createdAt).getTime()));
    const eligibleAfterMs = policy.eligibleAfter ? new Date(policy.eligibleAfter).getTime() : Number.NEGATIVE_INFINITY;
    const policyCooldownMs = (policy.cooldownHours ?? opts.cooldownHours) * 60 * 60 * 1000;
    if (nowMs < eligibleAfterMs || nowMs - latestEventMs < policyCooldownMs) {
      return { allowed: false, reason: "cooldown_active" };
    }
  }

  return { allowed: true, reason: null };
}

/** Backward-compatible name; all new cold-lead admission should use the explicit central policy. */
export const evaluateOutreachAttempt = canEnterColdOutreach;
