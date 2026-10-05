import { describe, expect, it } from "vitest";
import type { SetterDraft } from "@/domain/conversations/types";
import { computeSetterOperationsMetrics, requiresHumanIntervention } from "./operations-metrics";

function draft(needsHuman: boolean): SetterDraft {
  return {
    id: "draft-1",
    conversationMessageId: "message-1",
    language: "es",
    branch: "PRICE",
    intentSummary: "Asks for price",
    confidence: 0.8,
    draft: "Draft",
    needsHuman,
    reasonForHuman: null,
    detectedFactsRequested: [],
    riskFlags: [],
    suggestedNextAction: "manual_review",
    createdAt: "2026-10-03T10:00:00.000Z",
  };
}

describe("computeSetterOperationsMetrics", () => {
  it("calculates review SLA and decision rates from persisted timestamps", () => {
    const metrics = computeSetterOperationsMetrics({
      pendingItems: [
        { messageCreatedAt: "2026-10-03T09:00:00.000Z" },
        { messageCreatedAt: "2026-10-03T11:00:00.000Z" },
      ],
      drafts: [draft(true), { ...draft(false), id: "draft-2", conversationMessageId: "message-2", branch: "HUMAN_REQUIRED" }],
      feedback: [
        { conversationMessageId: "message-1", decision: "approve", reviewedAt: "2026-10-03T10:30:00.000Z" },
        { conversationMessageId: "message-2", decision: "edit_and_send", reviewedAt: "2026-10-03T11:30:00.000Z" },
      ],
      messageCreatedAtById: new Map([
        ["message-1", "2026-10-03T10:00:00.000Z"],
        ["message-2", "2026-10-03T11:00:00.000Z"],
      ]),
      webhookEvents: [
        { status: "pending_review", duplicateAttempts: 2 },
        { status: "duplicate_skipped" },
        { status: "human_required" },
        { status: "failed" },
        { status: "ignored" },
      ],
    });

    expect(requiresHumanIntervention(draft(true))).toBe(false);
    expect(requiresHumanIntervention({ ...draft(false), branch: "HUMAN_REQUIRED" })).toBe(true);
    expect(metrics.pendingCount).toBe(2);
    expect(metrics.oldestPendingAt).toBe("2026-10-03T09:00:00.000Z");
    expect(metrics.averageReviewMinutes).toBe(30);
    expect(metrics.humanRequiredRate).toBe(0.5);
    expect(metrics.approvalRate).toBe(0.5);
    expect(metrics.editRate).toBe(0.5);
    expect(metrics.rejectRate).toBe(0);
    expect(metrics.webhooks).toEqual({ received: 7, processed: 1, ignored: 1, duplicateSkipped: 3, humanRequired: 1, failed: 1 });
  });

  it("returns unavailable values when no source data exists", () => {
    const metrics = computeSetterOperationsMetrics({
      pendingItems: [],
      drafts: [],
      feedback: [],
      messageCreatedAtById: new Map(),
      webhookEvents: [],
    });

    expect(metrics.oldestPendingAt).toBeNull();
    expect(metrics.averageReviewMinutes).toBeNull();
    expect(metrics.humanRequiredRate).toBeNull();
    expect(metrics.approvalRate).toBeNull();
    expect(metrics.webhooks.received).toBe(0);
  });
});