import type { Conversation, ConversationMessage, ConversationState, ReviewDecision, SetterDraft, SetterFeedback } from "@/domain/conversations/types";

/**
 * Human review service (Prompt 4 §4.7). Applies one of the six review
 * actions to a draft, always recording a `SetterFeedback` row (original AI
 * draft, final human text, action, correction reason, branch correction,
 * timestamp, reviewer). Pure state transition — the caller is responsible
 * for actually delivering `outgoingMessage` via the outreach layer and for
 * calling the compliance suppression service when `decision === "suppress"`
 * (this service does not import `services/compliance/*` to keep the
 * dependency direction one-way: compliance has no knowledge of the setter).
 */

const STATE_BY_DECISION: Record<ReviewDecision, ConversationState> = {
  approve: "sent",
  edit_and_send: "sent",
  reject: "rejected",
  no_reply_needed: "no_reply_needed",
  escalate: "escalated",
  suppress: "suppressed",
};

export interface ReviewActionInput {
  draft: SetterDraft;
  conversation: Conversation;
  decision: ReviewDecision;
  finalText: string | null;
  correctionReason: string | null;
  correctedBranch: SetterDraft["branch"] | null;
  reviewerId: string;
  reviewedAt: string;
}

export interface ReviewActionResult {
  conversation: Conversation;
  feedback: SetterFeedback;
  outgoingMessage: ConversationMessage | null;
}

export function applyReviewDecision(input: ReviewActionInput, generateId: () => string): ReviewActionResult {
  if (input.decision === "edit_and_send" && !input.finalText) {
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
    decision: input.decision,
    reasonCategory: input.correctionReason,
    note: null,
    meetingOutcome: null,
    qualified: null,
    lostReason: null,
    reviewedAt: input.reviewedAt,
    reviewerId: input.reviewerId,
  };

  const outgoingMessage: ConversationMessage | null = finalText
    ? {
        id: generateId(),
        conversationId: conversation.id,
        direction: "outgoing",
        body: finalText,
        channel: conversation.channel,
        providerMessageId: null,
        metadata: { reviewDecision: input.decision },
        createdAt: input.reviewedAt,
      }
    : null;

  return { conversation, feedback, outgoingMessage };
}
