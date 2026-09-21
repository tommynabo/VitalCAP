import type { SetterBranch, SetterDraft, SetterFeedback } from "@/domain/conversations/types";

/**
 * Setter feedback analytics (Prompt 4 §4.8). Pure aggregation functions
 * over accumulated `SetterFeedback`/`SetterDraft` records — no persistence,
 * no LLM calls. Powers both the learning-loop context (recent feedback
 * summaries, capped, see `context-builder.ts`) and the AI Setter dashboard
 * (§4.11).
 */

const POSITIVE_BRANCHES: ReadonlySet<SetterBranch> = new Set(["INTEREST", "MEETING_REQUEST"]);

export interface SetterAnalyticsInput {
  feedback: readonly SetterFeedback[];
  drafts: readonly SetterDraft[];
  meetingsBookedCount: number;
}

export interface SetterAnalytics {
  totalReviewed: number;
  branchAccuracy: number;
  approvalRate: number;
  editRate: number;
  rejectionRate: number;
  positiveReplyToMeetingRate: number;
  averageEdits: number;
  confidenceCalibration: number;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function computeSetterAnalytics(input: SetterAnalyticsInput): SetterAnalytics {
  const total = input.feedback.length;
  if (total === 0) {
    return {
      totalReviewed: 0,
      branchAccuracy: 0,
      approvalRate: 0,
      editRate: 0,
      rejectionRate: 0,
      positiveReplyToMeetingRate: 0,
      averageEdits: 0,
      confidenceCalibration: 0,
    };
  }

  const correct = input.feedback.filter((f) => f.correctedBranch === null || f.correctedBranch === f.predictedBranch).length;
  const approved = input.feedback.filter((f) => f.decision === "approve").length;
  const edited = input.feedback.filter((f) => f.decision === "edit_and_send").length;
  const rejected = input.feedback.filter((f) => f.decision === "reject").length;
  const positiveCount = input.feedback.filter((f) => POSITIVE_BRANCHES.has(f.predictedBranch)).length;

  const draftByMessageId = new Map(input.drafts.map((draft) => [draft.conversationMessageId, draft]));
  let calibrationSum = 0;
  let calibrationCount = 0;
  for (const f of input.feedback) {
    const draft = draftByMessageId.get(f.conversationMessageId);
    if (!draft) continue;
    const isCorrect = f.correctedBranch === null || f.correctedBranch === f.predictedBranch ? 1 : 0;
    calibrationSum += Math.abs(draft.confidence - isCorrect);
    calibrationCount += 1;
  }

  return {
    totalReviewed: total,
    branchAccuracy: ratio(correct, total),
    approvalRate: ratio(approved, total),
    editRate: ratio(edited, total),
    rejectionRate: ratio(rejected, total),
    positiveReplyToMeetingRate: positiveCount === 0 ? 0 : Math.min(1, input.meetingsBookedCount / positiveCount),
    averageEdits: ratio(edited, total),
    confidenceCalibration: calibrationCount === 0 ? 0 : 1 - calibrationSum / calibrationCount,
  };
}

export interface BranchPerformanceRow {
  branch: SetterBranch;
  count: number;
  accuracy: number;
  averageConfidence: number;
}

export function computeBranchPerformance(feedback: readonly SetterFeedback[], drafts: readonly SetterDraft[]): BranchPerformanceRow[] {
  const draftByMessageId = new Map(drafts.map((draft) => [draft.conversationMessageId, draft]));
  const byBranch = new Map<SetterBranch, { count: number; correct: number; confidenceSum: number; confidenceCount: number }>();

  for (const f of feedback) {
    const bucket = byBranch.get(f.predictedBranch) ?? { count: 0, correct: 0, confidenceSum: 0, confidenceCount: 0 };
    bucket.count += 1;
    if (f.correctedBranch === null || f.correctedBranch === f.predictedBranch) bucket.correct += 1;
    const draft = draftByMessageId.get(f.conversationMessageId);
    if (draft) {
      bucket.confidenceSum += draft.confidence;
      bucket.confidenceCount += 1;
    }
    byBranch.set(f.predictedBranch, bucket);
  }

  return Array.from(byBranch.entries())
    .map(([branch, bucket]) => ({
      branch,
      count: bucket.count,
      accuracy: ratio(bucket.correct, bucket.count),
      averageConfidence: bucket.confidenceCount === 0 ? 0 : bucket.confidenceSum / bucket.confidenceCount,
    }))
    .sort((a, b) => b.count - a.count);
}
