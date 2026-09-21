import type { OutreachEvent, OutreachEventState } from "@/domain/outreach/types";

/**
 * Sequence service (Prompt 3 §3.9). Decides, for a single outreach path
 * (one account + one selected endpoint), whether the next scheduled step
 * should go out, wait, or be permanently stopped. The two hard rules from
 * the spec are enforced directly: (1) a reply anywhere in the path pauses
 * every further scheduled step — cold or warm — for that account, and (2) a
 * bounce/unsubscribe cancels the path outright rather than merely pausing
 * it.
 */

export type SequenceStepKind = "cold" | "warm_followup";

export interface SequenceStepDefinition {
  stepIndex: number;
  kind: SequenceStepKind;
  /** Minimum delay, in ms, after the previous step was sent before this step may go out. */
  delayAfterPreviousMs: number;
}

const TERMINAL_STOP_STATES: ReadonlySet<OutreachEventState> = new Set(["bounced", "unsubscribed", "suppressed", "canceled"]);
const SENT_STATES: ReadonlySet<OutreachEventState> = new Set(["sent", "delivered"]);

export type SequenceActionType = "send_next" | "wait" | "pause" | "cancel" | "complete";

export interface SequenceAction {
  action: SequenceActionType;
  nextStep: SequenceStepDefinition | null;
  reason: string | null;
}

export interface SequenceDecisionInput {
  steps: readonly SequenceStepDefinition[];
  events: readonly OutreachEvent[];
  now: Date;
}

export function decideNextSequenceAction(input: SequenceDecisionInput): SequenceAction {
  const sortedEvents = [...input.events].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

  const replyEvent = sortedEvents.find((event) => event.state === "replied");
  if (replyEvent) {
    return { action: "pause", nextStep: null, reason: "account_replied" };
  }

  const stopEvent = sortedEvents.find((event) => TERMINAL_STOP_STATES.has(event.state));
  if (stopEvent) {
    return { action: "cancel", nextStep: null, reason: `terminal_state:${stopEvent.state}` };
  }

  const sentEvents = sortedEvents.filter((event) => SENT_STATES.has(event.state));
  const completedStepCount = sentEvents.length;

  if (completedStepCount >= input.steps.length) {
    return { action: "complete", nextStep: null, reason: null };
  }

  const nextStep = input.steps[completedStepCount]!;
  const lastSentEvent = sentEvents.at(-1);
  const lastSentAtMs = lastSentEvent ? new Date(lastSentEvent.occurredAt).getTime() : null;

  if (lastSentAtMs !== null && input.now.getTime() - lastSentAtMs < nextStep.delayAfterPreviousMs) {
    return { action: "wait", nextStep, reason: null };
  }

  return { action: "send_next", nextStep, reason: null };
}
