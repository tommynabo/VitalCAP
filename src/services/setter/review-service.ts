import type { Conversation, ConversationMessage, ConversationState, ReviewDecision, SetterDraft, SetterFeedback } from "@/domain/conversations/types";

/**
 * Human review service (Prompt 4 §4.7). Applies a human review decision
 * actions to a draft, always recording a `SetterFeedback` row (original AI
 * draft, final human text, action, correction reason, branch correction,
 * timestamp, reviewer). This service never creates or sends an outbound
 * message; delivery requires a separate, explicitly authorized workflow.
 */

const STATE_BY_DECISION: Record<ReviewDecision, ConversationState> = {
  approve: "approved",
  edit_and_send: "edited",
  reject: "rejected",
  no_reply_needed: "no_reply_needed",
  escalate: "escalated",
  suppress: "suppressed",
  take_over: "human_owned",
};

export interface ReviewActionInput {
  draft: SetterDraft;
  conversation: Conversation;
  decision: ReviewDecision;
  finalText: string | null;
  correctionReason: string | null;
  correctedBranch: SetterDraft["branch"] | null;
  note?: string | null;
  reviewerId: string;
  reviewedAt: string;
}

export interface ReviewActionResult {
  conversation: Conversation;
  feedback: SetterFeedback;
  outgoingMessage: ConversationMessage | null;
}

export function applyReviewDecision(input: ReviewActionInput, generateId: () => string): ReviewActionResult {
  if (input.decision === "edit_and_send" && !input.finalText?.trim()) {
    throw new Error("edit_and_send requires finalText");
  }

  const finalText = input.decision === "approve" ? input.draft.draft : input.decision === "edit_and_send" ? input.finalText : null;

  const conversation: Conversation = {
    ...input.conversation,
    state: STATE_BY_DECISION[input.decision],
    latestIntent: input.correctedBranch ?? input.draft.branch,
    updatedAt: input.reviewedAt,
  };

  const feedback: SetterFeedback = {
    id: generateId(),
    conversationMessageId: input.draft.conversationMessageId,
    predictedBranch: input.draft.branch,
    correctedBranch: input.correctedBranch,
    aiDraft: input.draft.draft,
    correctedText: input.decision === "edit_and_send" ? input.finalText : null,
    finalText,
    decision: input.decision,
    reasonCategory: input.correctionReason,
    note: input.note ?? null,
    meetingOutcome: null,
    qualified: null,
    lostReason: null,
    reviewedAt: input.reviewedAt,
    reviewerId: input.reviewerId,
  };

  return { conversation, feedback, outgoingMessage: null };
}
