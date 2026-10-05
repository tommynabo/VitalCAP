import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, SetterDraft } from "@/domain/conversations/types";

const getSetterReviewItem = vi.fn();
const persistSetterReviewDecision = vi.fn();
const sendReviewedSetterReply = vi.fn();
const insertAuditLog = vi.fn();
const requireWorkspaceMember = vi.fn();
const getDeliveryEnv = vi.fn();

class UnauthorizedError extends Error {}

vi.mock("@/infrastructure/neon/repositories/setter-runtime", () => ({ getSetterReviewItem, persistSetterReviewDecision, sendReviewedSetterReply }));
vi.mock("@/infrastructure/neon/repositories/audit", () => ({ insertAuditLog }));
vi.mock("@/lib/auth/workspace", () => ({ UnauthorizedError, requireWorkspaceMember }));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv }));

const { PATCH } = await import("./route");

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
    persistSetterReviewDecision.mockResolvedValue(true);
    sendReviewedSetterReply.mockResolvedValue({ status: "sent", providerMessageId: "sent-message-1" });
    getDeliveryEnv.mockReturnValue({ EMAIL_DELIVERY_PROVIDER: "instantly", INSTANTLY_API_KEY: "server-key" });
    insertAuditLog.mockResolvedValue(undefined);
  });

  it.each([
    ["approve", undefined, "approved_pending_send", "Prepared AI response"],
    ["edit_and_send", "Human-edited response", "approved_pending_send", "Human-edited response"],
    ["reject", undefined, "rejected", null],
    ["take_over", undefined, "human_owned", null],
  ])("handles %s with the expected delivery behavior", async (decision, finalText, state, expectedFinalText) => {
    const response = await review(decision, finalText);
    const responseBody = await response.json();
    const [, , result] = persistSetterReviewDecision.mock.calls[0] as [string, typeof item, {
      conversation: Conversation;
      feedback: { finalText: string | null; reviewerId: string; reasonCategory: string | null };
      outgoingMessage: unknown;
    }];

    expect(response.status).toBe(200);
    expect(responseBody.delivery).toBe(decision === "approve" || decision === "edit_and_send" ? "sent" : "not_sent");
    expect(getSetterReviewItem).toHaveBeenCalledWith(workspaceId, draft.id);
    expect(result.conversation.state).toBe(state);
    expect(result.feedback.finalText).toBe(expectedFinalText);
    expect(result.feedback.reviewerId).toBe("member-1");
    expect(result.feedback.reasonCategory).toBe("other");
    expect(result.outgoingMessage).toBeNull();
    if (decision === "approve" || decision === "edit_and_send") {
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

  it("never calls outbound network from a review action", async () => {
    const outboundFetch = vi.spyOn(globalThis, "fetch");

    const response = await review("approve");

    expect(response.status).toBe(200);
    expect(outboundFetch).not.toHaveBeenCalled();
  });

  it("does not send if another request already claimed the review", async () => {
    persistSetterReviewDecision.mockResolvedValue(false);

    const response = await review("approve");

    expect(response.status).toBe(409);
    expect(sendReviewedSetterReply).not.toHaveBeenCalled();
  });

  it("does not mark a rejected provider response as sent", async () => {
    sendReviewedSetterReply.mockResolvedValue({ status: "failed", errorCode: "INSTANTLY_REPLY_401" });

    const response = await review("approve");
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ state: "send_failed", delivery: "failed", errorCode: "INSTANTLY_REPLY_401" });
  });
});