/**
 * Domain types for conversations and the AI Setter (Prompt 1 §1.1,
 * Prompt 4). The branch catalog is configurable in DB, not a hard-coded
 * enum in production — this union is a Phase-0 starting vocabulary only.
 */

import type { ContactPointType } from "@/domain/contacts/types";

export type SetterBranch =
  | "INTEREST"
  | "SEND_INFO"
  | "MARGIN"
  | "PRICE"
  | "MINIMUM_ORDER"
  | "PRODUCT_DETAILS"
  | "EXISTING_SUPPLIER"
  | "SAMPLES"
  | "CREDIBILITY"
  | "NOT_DECISION_MAKER"
  | "FORWARD_TO_PURCHASING"
  | "CALL_ME_LATER"
  | "MEETING_REQUEST"
  | "LOGISTICS"
  | "COMMERCIAL_TERMS"
  | "NOT_INTERESTED"
  | "UNSUBSCRIBE"
  | "UNKNOWN"
  | "HUMAN_REQUIRED";

export type ConversationState =
  | "reply_received"
  | "pre_routed"
  | "ai_classified"
  | "draft_ready"
  | "pending_review"
  | "approved"
  | "edited"
  | "rejected"
  | "escalated"
  | "sent"
  | "no_reply_needed"
  | "suppressed"
  | "meeting_booked"
  | "human_owned";

export interface Conversation {
  id: string;
  workspaceId: string;
  accountId: string;
  contactId: string | null;
  campaignId: string;
  offerId: string;
  channel: ContactPointType;
  /** Provider-side thread/conversation ID (Instantly thread ID, SMS conversation ID, ...), for idempotent reply matching. */
  providerThreadId: string | null;
  state: ConversationState;
  latestIntent: SetterBranch | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  direction: "incoming" | "outgoing";
  body: string;
  channel: ContactPointType;
  providerMessageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SetterDraft {
  id: string;
  conversationMessageId: string;
  language: string;
  branch: SetterBranch;
  intentSummary: string;
  confidence: number;
  draft: string;
  needsHuman: boolean;
  reasonForHuman: string | null;
  detectedFactsRequested: string[];
  riskFlags: string[];
  suggestedNextAction: string;
  createdAt: string;
}

export type ReviewDecision =
  | "approve"
  | "edit_and_send"
  | "reject"
  | "no_reply_needed"
  | "escalate"
  | "suppress";

export interface SetterFeedback {
  id: string;
  conversationMessageId: string;
  predictedBranch: SetterBranch;
  correctedBranch: SetterBranch | null;
  aiDraft: string;
  correctedText: string | null;
  decision: ReviewDecision;
  reasonCategory: string | null;
  note: string | null;
  meetingOutcome: string | null;
  qualified: boolean | null;
  lostReason: string | null;
  reviewedAt: string;
  reviewerId: string;
}

export interface Meeting {
  id: string;
  conversationId: string;
  scheduledFor: string;
  bookingUrl: string;
  createdAt: string;
}
