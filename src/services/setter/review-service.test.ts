import { describe, expect, it } from "vitest";
import type { Conversation, SetterDraft } from "@/domain/conversations/types";
import { applyReviewDecision, type ReviewActionInput } from "./review-service";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

function conversationFixture(): Conversation {
  return {
    id: "conv-1",
    workspaceId: "ws-1",
    accountId: "acc-1",
    contactId: "contact-1",
    campaignId: "camp-1",
    offerId: "offer-1",
    channel: "email",
    providerThreadId: "thread-1",
    state: "pending_review",
    latestIntent: "PRICE",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function draftFixture(): SetterDraft {
  return {
    id: "draft-1",
    conversationMessageId: "msg-1",
    language: "es",
    branch: "PRICE",
    intentSummary: "Lead asks for price",
    confidence: 0.8,
    draft: "Gracias por su interés, coordinemos una llamada.",
    needsHuman: false,
    reasonForHuman: null,
    detectedFactsRequested: ["price"],
    riskFlags: [],
    suggestedNextAction: "book_meeting",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function baseInput(overrides: Partial<ReviewActionInput> = {}): ReviewActionInput {
  return {
    draft: draftFixture(),
    conversation: conversationFixture(),
    decision: "approve",
    finalText: null,
    correctionReason: null,
    correctedBranch: null,
    reviewerId: "reviewer-1",
    reviewedAt: "2024-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyReviewDecision", () => {
  it("approve: records the AI draft as final and queues the explicit human-approved send", () => {
    const result = applyReviewDecision(baseInput(), nextId);
    expect(result.conversation.state).toBe("approved_pending_send");
    expect(result.outgoingMessage).toBeNull();
    expect(result.feedback.decision).toBe("approve");
    expect(result.feedback.correctedText).toBeNull();
    expect(result.feedback.finalText).toBe(draftFixture().draft);
  });

  it("edit_and_send: records the exact human text and queues that text for sending", () => {
    const result = applyReviewDecision(baseInput({ decision: "edit_and_send", finalText: "Texto corregido por humano." }), nextId);
    expect(result.conversation.state).toBe("approved_pending_send");
    expect(result.outgoingMessage).toBeNull();
    expect(result.feedback.correctedText).toBe("Texto corregido por humano.");
    expect(result.feedback.finalText).toBe("Texto corregido por humano.");
  });

  it("take_over assigns the existing human_owned state and creates no outgoing message", () => {
    const result = applyReviewDecision(baseInput({ decision: "take_over" }), nextId);
    expect(result.conversation.state).toBe("human_owned");
    expect(result.outgoingMessage).toBeNull();
  });

  it("edit_and_send without finalText throws", () => {
    expect(() => applyReviewDecision(baseInput({ decision: "edit_and_send", finalText: null }), nextId)).toThrow();
  });

  it("approve without an AI draft throws rather than claiming an empty send", () => {
    expect(() => applyReviewDecision(baseInput({ draft: { ...draftFixture(), draft: "" } }), nextId)).toThrow("approve requires draft text");
  });

  it("reject: no outgoing message, conversation moves to rejected", () => {
    const result = applyReviewDecision(baseInput({ decision: "reject" }), nextId);
    expect(result.outgoingMessage).toBeNull();
    expect(result.conversation.state).toBe("rejected");
  });

  it("no_reply_needed: no outgoing message", () => {
    const result = applyReviewDecision(baseInput({ decision: "no_reply_needed" }), nextId);
    expect(result.outgoingMessage).toBeNull();
    expect(result.conversation.state).toBe("no_reply_needed");
  });

  it("escalate: no outgoing message, conversation moves to escalated", () => {
    const result = applyReviewDecision(baseInput({ decision: "escalate" }), nextId);
    expect(result.outgoingMessage).toBeNull();
    expect(result.conversation.state).toBe("escalated");
  });

  it("suppress: no outgoing message, conversation moves to suppressed", () => {
    const result = applyReviewDecision(baseInput({ decision: "suppress" }), nextId);
    expect(result.outgoingMessage).toBeNull();
    expect(result.conversation.state).toBe("suppressed");
  });

  it("records a branch correction distinct from the AI's predicted branch", () => {
    const result = applyReviewDecision(baseInput({ correctedBranch: "MARGIN" }), nextId);
    expect(result.feedback.predictedBranch).toBe("PRICE");
    expect(result.feedback.correctedBranch).toBe("MARGIN");
    expect(result.conversation.latestIntent).toBe("MARGIN");
  });
});
