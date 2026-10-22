import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, SetterDraft } from "@/domain/conversations/types";

const getSetterReviewItem = vi.fn();
const getSetterReviewSendDiagnostics = vi.fn();
const persistSetterReviewDecision = vi.fn();
const sendReviewedSetterReply = vi.fn();
const insertAuditLog = vi.fn();
const requireWorkspaceMember = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/infrastructure/neon/repositories/setter-runtime", () => ({ getSetterReviewItem, getSetterReviewSendDiagnostics, persistSetterReviewDecision, sendReviewedSetterReply }));
vi.mock("@/infrastructure/neon/repositories/audit", () => ({ insertAuditLog }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));

const { GET, PATCH } = await import("./route");

const workspaceId = "00000000-0000-4000-8000-000000000001";
const draft: SetterDraft = {
  id: "00000000-0000-4000-8000-000000000002",
  conversationMessageId: "00000000-0000-4000-8000-000000000003",
  language: "es",
  branch: "PRICE",
  intentSummary: "Asks for pricing",
  confidence: 0.8,
  draft: "Prepared AI response",
  needsHuman: true,
  reasonForHuman: null,
  detectedFactsRequested: ["price"],
  riskFlags: [],
  suggestedNextAction: "manual_review",
  createdAt: "2026-10-03T10:00:00.000Z",
};
const conversation: Conversation = {
  id: "00000000-0000-4000-8000-000000000004",
  workspaceId,
  accountId: "00000000-0000-4000-8000-000000000005",
  contactId: null,
  campaignId: "00000000-0000-4000-8000-000000000006",
  offerId: "00000000-0000-4000-8000-000000000007",
  channel: "email",
  providerThreadId: "thread-1",
  state: "pending_review",
  latestIntent: "PRICE",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};
const item = { draft, conversation, message: {
  id: draft.conversationMessageId,
  conversationId: conversation.id,
  direction: "incoming" as const,
  body: "What is your price?",
  channel: "email",
  providerMessageId: "provider-message-1",
  metadata: {},
  createdAt: "2026-10-03T10:00:00.000Z",
} };

async function review(decision: string, finalText?: string) {
  return PATCH(new Request("http://localhost/api/setter/reviews/draft", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, finalText: finalText ?? null, correctionReason: "other", note: "Reviewed by operator" }),
  }), { params: Promise.resolve({ draftId: draft.id }) });
}

describe("PATCH /api/setter/reviews/[draftId]", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMember.mockResolvedValue({ workspaceId, user: { userId: "member-1" }, role: "member" });
    getSetterReviewItem.mockResolvedValue(item);
    getSetterReviewSendDiagnostics.mockResolvedValue({
      draftExists: true,
      conversationState: "approved_pending_send",
      reviewFeedbackExists: true,
      reviewAuditExists: true,
      finalTextExists: true,
      incomingProviderMessageIdExists: true,
      incomingProviderMessageIdValid: true,
      replyToUuidExists: true,
      replyToUuidValid: true,
      emailAccountExists: false,
      replyDeliveryStatus: null,
      replyDeliveryErrorCode: null,
      providerMessageIdExists: false,
      sendAttempted: false,
    });
    persistSetterReviewDecision.mockResolvedValue(true);
    sendReviewedSetterReply.mockResolvedValue({ status: "accepted", providerMessageId: "sent-message-1" });
    insertAuditLog.mockResolvedValue(undefined);
  });

  it("returns only safe, workspace-scoped send diagnostics", async () => {
    const response = await GET(new Request("http://localhost/api/setter/reviews/draft"), { params: Promise.resolve({ draftId: draft.id }) });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      draftExists: true,
      conversationState: "approved_pending_send",
      reviewFeedbackExists: true,
      finalTextExists: true,
      replyToUuidValid: true,
      sendAttempted: false,
    });
    expect(result).not.toHaveProperty("finalText");
    expect(getSetterReviewSendDiagnostics).toHaveBeenCalledWith(workspaceId, draft.id);
  });

  it.each([
    ["approve", undefined, "approved_pending_send", "Prepared AI response"],
    ["edit_and_send", "Human-edited response", "approved_pending_send", "Human-edited response"],
    ["reject", undefined, "rejected", null],
    ["take_over", undefined, "human_owned", null],
  ])("persists %s and sends only approved decisions", async (decision, finalText, state, expectedFinalText) => {
    const response = await review(decision, finalText);
    const responseBody = await response.json();
    const [, , result] = persistSetterReviewDecision.mock.calls[0] as [string, typeof item, {
      conversation: Conversation;
      feedback: { finalText: string | null; reviewerId: string; reasonCategory: string | null };
      outgoingMessage: unknown;
    }];

    expect(response.status).toBe(200);
    expect(responseBody.delivery.status).toBe(decision === "approve" || decision === "edit_and_send" ? "accepted" : "not_sent");
    expect(getSetterReviewItem).toHaveBeenCalledWith(workspaceId, draft.id);
    expect(result.conversation.state).toBe(state);
    expect(result.feedback.finalText).toBe(expectedFinalText);
    expect(result.feedback.reviewerId).toBe("member-1");
    expect(result.feedback.reasonCategory).toBe("other");
    expect(result.outgoingMessage).toBeNull();
    if (decision === "approve" || decision === "edit_and_send") {
      expect(sendReviewedSetterReply).toHaveBeenCalledOnce();
      expect(sendReviewedSetterReply).toHaveBeenCalledWith(workspaceId, draft.id);
    } else {
      expect(sendReviewedSetterReply).not.toHaveBeenCalled();
    }
  });

  it("returns not found for a draft outside the authenticated workspace", async () => {
    getSetterReviewItem.mockResolvedValue(null);

    const response = await review("approve");

    expect(response.status).toBe(404);
    expect(getSetterReviewItem).toHaveBeenCalledWith(workspaceId, draft.id);
    expect(persistSetterReviewDecision).not.toHaveBeenCalled();
    expect(insertAuditLog).not.toHaveBeenCalled();
  });

  it("handles a repeated review safely when another request already persisted it", async () => {
    persistSetterReviewDecision.mockResolvedValue(false);

    const response = await review("approve");

    expect(response.status).toBe(409);
    expect(sendReviewedSetterReply).not.toHaveBeenCalled();
    expect(insertAuditLog).not.toHaveBeenCalled();
  });

  it("preserves the persisted review and returns provider failure separately", async () => {
    sendReviewedSetterReply.mockResolvedValue({ status: "failed", errorCode: "INSTANTLY_REPLY_REJECTED" });

    const response = await review("approve");
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(persistSetterReviewDecision).toHaveBeenCalledOnce();
    expect(responseBody).toMatchObject({ state: "send_failed", delivery: { status: "failed", errorCode: "INSTANTLY_REPLY_REJECTED" } });
    expect(responseBody.error).toBeUndefined();
  });

  it("does not call the sender when the review audit write fails after persistence", async () => {
    insertAuditLog.mockRejectedValueOnce(new Error("simulated audit failure"));
    getSetterReviewItem
      .mockResolvedValueOnce(item)
      .mockResolvedValue({ ...item, conversation: { ...conversation, state: "approved_pending_send" } });

    const response = await review("approve");
    const responseBody = await response.json();

    expect(response.status).toBe(500);
    expect(responseBody).toMatchObject({
      state: "approved_pending_send",
      delivery: { status: "not_sent", errorCode: "REVIEW_AUDIT_PERSIST_FAILED" },
    });
    expect(responseBody.error).not.toBe("Review decision could not be saved.");
    expect(sendReviewedSetterReply).not.toHaveBeenCalled();
  });

  it("never retries a send_unknown item on another approve request", async () => {
    getSetterReviewItem.mockResolvedValue({
      ...item,
      conversation: { ...conversation, state: "send_unknown" },
      message: { ...item.message, metadata: { replyDelivery: { status: "send_unknown", errorCode: "INSTANTLY_REPLY_RESULT_UNCERTAIN" } } },
    });

    const response = await review("approve");
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(responseBody).toMatchObject({ state: "send_unknown", delivery: { status: "uncertain" } });
    expect(sendReviewedSetterReply).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid decisions and missing correction text", async () => {
    expect((await review("approved")).status).toBe(400);
    expect((await review("edit_and_send")).status).toBe(400);
    expect(persistSetterReviewDecision).not.toHaveBeenCalled();
  });
});