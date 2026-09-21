import { describe, expect, it } from "vitest";
import type { Conversation, ConversationMessage } from "@/domain/conversations/types";
import { ingestIncomingReply, type IncomingReplyPayload } from "./reply-ingestion";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

function payload(overrides: Partial<IncomingReplyPayload> = {}): IncomingReplyPayload {
  return {
    workspaceId: "ws-1",
    accountId: "acc-1",
    contactId: "contact-1",
    campaignId: "camp-1",
    offerId: "offer-1",
    channel: "email",
    providerThreadId: "thread-1",
    providerMessageId: "msg-provider-1",
    body: "Que precio tienen?",
    occurredAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ingestIncomingReply", () => {
  it("creates a new conversation and message on first ingestion", () => {
    const result = ingestIncomingReply([], [], payload(), nextId);
    expect(result.outcome).toBe("conversation_created");
    expect(result.conversations).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
    expect(result.conversation.state).toBe("reply_received");
    expect(result.message.direction).toBe("incoming");
  });

  it("is idempotent: replaying the same providerMessageId does not duplicate", () => {
    const first = ingestIncomingReply([], [], payload(), nextId);
    const second = ingestIncomingReply(first.conversations, first.messages, payload(), nextId);
    expect(second.outcome).toBe("duplicate_skipped");
    expect(second.conversations).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
  });

  it("reuses the existing conversation for a second distinct message on the same thread", () => {
    const first = ingestIncomingReply([], [], payload(), nextId);
    const second = ingestIncomingReply(
      first.conversations,
      first.messages,
      payload({ providerMessageId: "msg-provider-2", body: "Otra pregunta" }),
      nextId,
    );
    expect(second.outcome).toBe("conversation_reused");
    expect(second.conversations).toHaveLength(1);
    expect(second.messages).toHaveLength(2);
    expect(second.conversation.id).toBe(first.conversation.id);
  });

  it("creates a separate conversation for a different provider thread", () => {
    const first = ingestIncomingReply([], [], payload(), nextId);
    const second = ingestIncomingReply(
      first.conversations,
      first.messages,
      payload({ providerThreadId: "thread-2", providerMessageId: "msg-provider-3" }),
      nextId,
    );
    expect(second.outcome).toBe("conversation_created");
    expect(second.conversations).toHaveLength(2);
  });

  it("throws if a duplicate message references a conversation missing from the given list", () => {
    const orphanConversation: Conversation = {
      id: "conv-missing-ref",
      workspaceId: "ws-1",
      accountId: "acc-1",
      contactId: null,
      campaignId: "camp-1",
      offerId: "offer-1",
      channel: "email",
      providerThreadId: "thread-x",
      state: "reply_received",
      latestIntent: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const orphanMessage: ConversationMessage = {
      id: "orphan-msg",
      conversationId: "conv-does-not-exist",
      direction: "incoming",
      body: "hi",
      channel: "email",
      providerMessageId: "msg-provider-1",
      metadata: {},
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => ingestIncomingReply([orphanConversation], [orphanMessage], payload(), nextId)).toThrow();
  });
});
