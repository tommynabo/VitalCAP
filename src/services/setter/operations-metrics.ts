import type { ReviewDecision, SetterDraft } from "@/domain/conversations/types";

export interface PendingReviewMetricItem {
  messageCreatedAt: string;
}

export interface ReviewMetricFeedback {
  conversationMessageId: string;
  decision: ReviewDecision;
  reviewedAt: string;
}

export interface WebhookMetricEvent {
  status: string;
  duplicateAttempts?: number;
}

export interface SetterOperationsMetrics {
  pendingCount: number;
  oldestPendingAt: string | null;
  averageReviewMinutes: number | null;
  humanRequiredRate: number | null;
  approvalRate: number | null;
  editRate: number | null;
  rejectRate: number | null;
  webhooks: {
    received: number;
    processed: number;
    duplicateSkipped: number;
    humanRequired: number;
    failed: number;
  };
}

export function requiresHumanIntervention(draft: SetterDraft): boolean {
  return draft.branch === "HUMAN_REQUIRED"
    || Boolean(draft.reasonForHuman)
    || draft.riskFlags.length > 0
    || draft.confidence < 0.6;
}

const TERMINAL_WEBHOOK_STATUSES = new Set(["duplicate_skipped", "human_required", "failed"]);
const CONVERSATION_STATES = new Set([
  "reply_received",
  "pre_routed",
  "ai_classified",
  "draft_ready",
  "pending_review",
  "approved",
  "edited",
  "rejected",
  "escalated",
  "sent",
  "no_reply_needed",
  "suppressed",
  "meeting_booked",
  "human_owned",
]);

function rate(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

export function computeSetterOperationsMetrics(input: {
  pendingItems: PendingReviewMetricItem[];
  drafts: SetterDraft[];
  feedback: ReviewMetricFeedback[];
  messageCreatedAtById: ReadonlyMap<string, string>;
  webhookEvents: WebhookMetricEvent[];
}): SetterOperationsMetrics {
  const oldestPendingAt = input.pendingItems.reduce<string | null>((oldest, item) => {
    if (!oldest || Date.parse(item.messageCreatedAt) < Date.parse(oldest)) return item.messageCreatedAt;
    return oldest;
  }, null);

  const reviewDurations = input.feedback.flatMap((item) => {
    const messageCreatedAt = input.messageCreatedAtById.get(item.conversationMessageId);
    if (!messageCreatedAt) return [];
    const duration = Date.parse(item.reviewedAt) - Date.parse(messageCreatedAt);
    return Number.isFinite(duration) && duration >= 0 ? [duration / 60_000] : [];
  });
  const reviewedCount = input.feedback.length;
  const decisionCount = (decision: ReviewDecision) => input.feedback.filter((item) => item.decision === decision).length;
  const eventCount = (status: string) => input.webhookEvents.filter((event) => event.status === status).length;
  const duplicateAttempts = input.webhookEvents.reduce((total, event) => total + (event.duplicateAttempts ?? 0), 0);

  return {
    pendingCount: input.pendingItems.length,
    oldestPendingAt,
    averageReviewMinutes: reviewDurations.length === 0
      ? null
      : reviewDurations.reduce((total, duration) => total + duration, 0) / reviewDurations.length,
    humanRequiredRate: rate(input.drafts.filter(requiresHumanIntervention).length, input.drafts.length),
    approvalRate: rate(decisionCount("approve"), reviewedCount),
    editRate: rate(decisionCount("edit_and_send"), reviewedCount),
    rejectRate: rate(decisionCount("reject"), reviewedCount),
    webhooks: {
      received: input.webhookEvents.length + duplicateAttempts,
      processed: input.webhookEvents.filter((event) => !TERMINAL_WEBHOOK_STATUSES.has(event.status)
        && CONVERSATION_STATES.has(event.status)).length,
      duplicateSkipped: eventCount("duplicate_skipped") + duplicateAttempts,
      humanRequired: eventCount("human_required"),
      failed: eventCount("failed"),
    },
  };
}