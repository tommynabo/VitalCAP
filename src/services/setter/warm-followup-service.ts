import type { SetterBranch } from "@/domain/conversations/types";

/**
 * Warm follow-up scheduler (Prompt 4 §4.12). Deliberately separate from
 * Phase 3's cold-outreach `sequence-service.ts` — a positive/interested
 * lead that replied but has not booked enters this queue instead of the
 * cold cadence. Pauses immediately (never silently keeps sending) on any
 * of the four triggers the spec names.
 */

const WARM_FOLLOWUP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

const WARM_ELIGIBLE_BRANCHES: ReadonlySet<SetterBranch> = new Set(["INTEREST", "SEND_INFO", "CALL_ME_LATER", "PRODUCT_DETAILS", "SAMPLES"]);

export type WarmFollowupStatus = "active" | "paused" | "completed";
export type WarmFollowupPauseTrigger = "reply" | "meeting" | "unsubscribe" | "human_ownership";

export interface WarmFollowupQueueItem {
  id: string;
  conversationId: string;
  enteredAt: string;
  status: WarmFollowupStatus;
  pauseReason: WarmFollowupPauseTrigger | null;
  nextFollowupAt: string | null;
}

/** Returns null when the branch isn't warm-eligible or a meeting is already booked — nothing to enqueue. */
export function enterWarmFollowupQueue(
  conversationId: string,
  branch: SetterBranch,
  hasMeetingBooked: boolean,
  enteredAt: string,
  generateId: () => string,
): WarmFollowupQueueItem | null {
  if (hasMeetingBooked) return null;
  if (!WARM_ELIGIBLE_BRANCHES.has(branch)) return null;

  return {
    id: generateId(),
    conversationId,
    enteredAt,
    status: "active",
    pauseReason: null,
    nextFollowupAt: new Date(new Date(enteredAt).getTime() + WARM_FOLLOWUP_DELAY_MS).toISOString(),
  };
}

/** Any of the four triggers immediately pauses (or, for "meeting", completes) the queue item. */
export function applyWarmFollowupTrigger(item: WarmFollowupQueueItem, trigger: WarmFollowupPauseTrigger): WarmFollowupQueueItem {
  return {
    ...item,
    status: trigger === "meeting" ? "completed" : "paused",
    pauseReason: trigger,
    nextFollowupAt: null,
  };
}

export function isDueForFollowup(item: WarmFollowupQueueItem, now: Date): boolean {
  if (item.status !== "active" || !item.nextFollowupAt) return false;
  return now.getTime() >= new Date(item.nextFollowupAt).getTime();
}

/**
 * Records that a follow-up was just dispatched and re-arms the item for the
 * next one — there's no "max follow-up count" concept in this schema (only
 * a single re-armable `nextFollowupAt`), so the item stays `active`
 * indefinitely until an actual pause/complete trigger fires via
 * `applyWarmFollowupTrigger`. Reuses the exact same delay constant/formula
 * `enterWarmFollowupQueue` already uses.
 */
export function recordFollowupDispatch(item: WarmFollowupQueueItem, now: Date): WarmFollowupQueueItem {
  return { ...item, nextFollowupAt: new Date(now.getTime() + WARM_FOLLOWUP_DELAY_MS).toISOString() };
}
