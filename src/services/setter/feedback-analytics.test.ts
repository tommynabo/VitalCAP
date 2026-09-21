import { describe, expect, it } from "vitest";
import type { SetterDraft, SetterFeedback } from "@/domain/conversations/types";
import { computeBranchPerformance, computeSetterAnalytics } from "./feedback-analytics";

function draft(overrides: Partial<SetterDraft> = {}): SetterDraft {
  return {
    id: "draft-1",
    conversationMessageId: "msg-1",
    language: "es",
    branch: "PRICE",
    intentSummary: "summary",
    confidence: 0.8,
    draft: "draft text",
    needsHuman: false,
    reasonForHuman: null,
    detectedFactsRequested: [],
    riskFlags: [],
    suggestedNextAction: "book_meeting",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function feedback(overrides: Partial<SetterFeedback> = {}): SetterFeedback {
  return {
    id: "fb-1",
    conversationMessageId: "msg-1",
    predictedBranch: "PRICE",
    correctedBranch: null,
    aiDraft: "draft text",
    correctedText: null,
    decision: "approve",
    reasonCategory: null,
    note: null,
    meetingOutcome: null,
    qualified: null,
    lostReason: null,
    reviewedAt: "2024-01-02T00:00:00.000Z",
    reviewerId: "reviewer-1",
    ...overrides,
  };
}

describe("computeSetterAnalytics", () => {
  it("returns all-zero analytics for an empty feedback set", () => {
    const analytics = computeSetterAnalytics({ feedback: [], drafts: [], meetingsBookedCount: 0 });
    expect(analytics.totalReviewed).toBe(0);
    expect(analytics.branchAccuracy).toBe(0);
  });

  it("computes approval/edit/rejection rates from a mixed feedback set", () => {
    const feedbackEntries = [
      feedback({ conversationMessageId: "msg-1", decision: "approve" }),
      feedback({ conversationMessageId: "msg-2", decision: "edit_and_send" }),
      feedback({ conversationMessageId: "msg-3", decision: "reject" }),
      feedback({ conversationMessageId: "msg-4", decision: "no_reply_needed" }),
    ];
    const analytics = computeSetterAnalytics({ feedback: feedbackEntries, drafts: [], meetingsBookedCount: 0 });
    expect(analytics.totalReviewed).toBe(4);
    expect(analytics.approvalRate).toBe(0.25);
    expect(analytics.editRate).toBe(0.25);
    expect(analytics.rejectionRate).toBe(0.25);
  });

  it("computes branch accuracy penalizing corrected branches", () => {
    const feedbackEntries = [
      feedback({ conversationMessageId: "msg-1", correctedBranch: null }),
      feedback({ conversationMessageId: "msg-2", correctedBranch: "MARGIN" }),
    ];
    const analytics = computeSetterAnalytics({ feedback: feedbackEntries, drafts: [], meetingsBookedCount: 0 });
    expect(analytics.branchAccuracy).toBe(0.5);
  });

  it("caps positive-reply-to-meeting rate at 1.0", () => {
    const feedbackEntries = [feedback({ conversationMessageId: "msg-1", predictedBranch: "INTEREST" })];
    const analytics = computeSetterAnalytics({ feedback: feedbackEntries, drafts: [], meetingsBookedCount: 5 });
    expect(analytics.positiveReplyToMeetingRate).toBe(1);
  });

  it("computes confidence calibration as 1 for perfectly calibrated correct-high-confidence predictions", () => {
    const drafts = [draft({ conversationMessageId: "msg-1", confidence: 1 })];
    const feedbackEntries = [feedback({ conversationMessageId: "msg-1", correctedBranch: null })];
    const analytics = computeSetterAnalytics({ feedback: feedbackEntries, drafts, meetingsBookedCount: 0 });
    expect(analytics.confidenceCalibration).toBe(1);
  });
});

describe("computeBranchPerformance", () => {
  it("groups accuracy and average confidence by predicted branch", () => {
    const drafts = [draft({ conversationMessageId: "msg-1", branch: "PRICE", confidence: 0.9 }), draft({ conversationMessageId: "msg-2", branch: "PRICE", confidence: 0.7 })];
    const feedbackEntries = [
      feedback({ conversationMessageId: "msg-1", predictedBranch: "PRICE", correctedBranch: null }),
      feedback({ conversationMessageId: "msg-2", predictedBranch: "PRICE", correctedBranch: "MARGIN" }),
    ];
    const rows = computeBranchPerformance(feedbackEntries, drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branch).toBe("PRICE");
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.accuracy).toBe(0.5);
    expect(rows[0]?.averageConfidence).toBeCloseTo(0.8);
  });

  it("sorts branches by descending count", () => {
    const feedbackEntries = [
      feedback({ conversationMessageId: "msg-1", predictedBranch: "PRICE" }),
      feedback({ conversationMessageId: "msg-2", predictedBranch: "MARGIN" }),
      feedback({ conversationMessageId: "msg-3", predictedBranch: "MARGIN" }),
    ];
    const rows = computeBranchPerformance(feedbackEntries, []);
    expect(rows[0]?.branch).toBe("MARGIN");
    expect(rows[0]?.count).toBe(2);
  });
});
