import type { ContactPointType } from "@/domain/contacts/types";
import type { OutreachEventState } from "@/domain/outreach/types";

export interface OutreachAttemptContext {
  contactPointId: string;
  accountId: string;
  campaignId: string;
  channel: ContactPointType;
  now: string;
}

export interface RecentOutreachEvent {
  contactPointId: string;
  accountId: string;
  campaignId: string;
  channel: ContactPointType;
  createdAt: string;
  state: OutreachEventState;
}

export interface SuppressionCheckEntry {
  contactPointId: string | null;
  accountId: string | null;
}

export interface OutreachDedupOptions {
  cooldownHours: number;
  /** Non-negotiable #11: never contact several endpoints at the same account simultaneously by default. */
  allowSimultaneousAccountContacts: boolean;
}

export const DEFAULT_OUTREACH_DEDUP_OPTIONS: OutreachDedupOptions = {
  cooldownHours: 24 * 14,
  allowSimultaneousAccountContacts: false,
};

export type OutreachDedupReason = "suppressed" | "cooldown_active" | "account_concurrency_lock";

export interface OutreachDedupDecision {
  allowed: boolean;
  reason: OutreachDedupReason | null;
}

/** States considered "in flight" — awaiting an outcome before a fallback contact point may be tried. */
const IN_FLIGHT_STATES: readonly OutreachEventState[] = ["queued", "scheduled", "provider_submitted", "sent", "delivered"];

/**
 * Decides whether a new outreach attempt may be queued (Prompt 1 §1.2
 * outreach dedup). Order matters: suppression always wins, then per-endpoint
 * cooldown, then account-level concurrency (contact the highest-priority
 * eligible endpoint first and wait for an outcome before trying a fallback).
 */
export function evaluateOutreachAttempt(
  context: OutreachAttemptContext,
  recentEvents: readonly RecentOutreachEvent[],
  suppressionEntries: readonly SuppressionCheckEntry[],
  options: Partial<OutreachDedupOptions> = {},
): OutreachDedupDecision {
  const opts = { ...DEFAULT_OUTREACH_DEDUP_OPTIONS, ...options };

  const isSuppressed = suppressionEntries.some(
    (entry) => entry.contactPointId === context.contactPointId || entry.accountId === context.accountId,
  );
  if (isSuppressed) return { allowed: false, reason: "suppressed" };

  const cooldownMs = opts.cooldownHours * 60 * 60 * 1000;
  const nowMs = new Date(context.now).getTime();

  const sameEndpointEvents = recentEvents.filter(
    (event) =>
      event.contactPointId === context.contactPointId &&
      event.campaignId === context.campaignId &&
      event.channel === context.channel,
  );
  const withinCooldown = sameEndpointEvents.some((event) => nowMs - new Date(event.createdAt).getTime() < cooldownMs);
  if (withinCooldown) return { allowed: false, reason: "cooldown_active" };

  if (!opts.allowSimultaneousAccountContacts) {
    const otherEndpointInFlight = recentEvents.some(
      (event) =>
        event.accountId === context.accountId &&
        event.campaignId === context.campaignId &&
        event.contactPointId !== context.contactPointId &&
        IN_FLIGHT_STATES.includes(event.state),
    );
    if (otherEndpointInFlight) return { allowed: false, reason: "account_concurrency_lock" };
  }

  return { allowed: true, reason: null };
}
