import { describe, expect, it, vi } from "vitest";
import type { Conversation, ConversationMessage } from "@/domain/conversations/types";
import type { InboundEmailReply, LLMProvider } from "@/domain/providers/types";
import { seedAccountBundles, seedOffer } from "@/lib/seed/dev-seed";
import { MockLLMProvider } from "@/infrastructure/providers/llm/mock-provider";
import { processInstantlyInboundReply, type PersistedInboundReply, type SetterInboundRuntimeStore } from "./inbound-runtime";

const event: InboundEmailReply = {
  providerEventId: "event-1",
  providerMessageId: "message-1",
  providerThreadId: "thread-1",
  providerCampaignId: "campaign-1",
  email: "owner@example.es",
  subject: "Question",
  body: "Que precio tienen?",
  occurredAt: "2026-10-03T10:00:00.000Z",
};

function persistedReply(): PersistedInboundReply {
  const conversation: Conversation = {
    id: "conversation-1",
    workspaceId: "ws_demo",
    accountId: seedAccountBundles[0]!.account.id,
    contactId: null,
    campaignId: "campaign-1",
    offerId: seedOffer.id,
    channel: "email",
    providerThreadId: event.providerThreadId,
    state: "reply_received",
    latestIntent: null,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
  const message: ConversationMessage = {
    id: "message-row-1",
    conversationId: conversation.id,
    direction: "incoming",
    body: event.body,
    channel: "email",
    providerMessageId: event.providerMessageId,
    metadata: { providerEventId: event.providerEventId },
    createdAt: event.occurredAt,
  };
  return { conversation, message, conversationMessages: [message] };
}

function storeFixture(): SetterInboundRuntimeStore & { claimCount: number; persistCount: number; drafts: unknown[]; statuses: string[] } {
  const claimed = new Set<string>();
  const persisted = persistedReply();
  return {
    claimCount: 0,
    persistCount: 0,
    drafts: [],
    statuses: [],
    async claimWebhookEvent(incomingEvent, _hash) {
      this.claimCount += 1;
      if (claimed.has(incomingEvent.providerMessageId)) return false;
      claimed.add(incomingEvent.providerMessageId);
      return true;
    },
    async persistIncomingReply(incomingEvent) {
      this.persistCount += 1;
      return {
        ...persisted,
        conversation: { ...persisted.conversation, providerThreadId: incomingEvent.providerThreadId },
        message: {
          ...persisted.message,
          body: incomingEvent.body,
          providerMessageId: incomingEvent.providerMessageId,
          createdAt: incomingEvent.occurredAt,
        },
      };
    },
    async loadContext() {
      return {
        workspaceId: "ws_demo",
        offer: seedOffer,
        account: seedAccountBundles[0]!.account,
        contact: null,
        discoverySource: "maps",
        recentFeedback: [],
        suppressionEntries: [],
        contactPointId: "contact-point-1",
      };
    },
    async persistResult(_persisted, result) {
      if (result.draft) this.drafts.push(result.draft);
    },
    async persistFailure(_persisted, failureCode) {
      this.drafts.push({ branch: "HUMAN_REQUIRED", riskFlags: [failureCode] });
    },
    async completeWebhookEvent(_event, status) {
      this.statuses.push(status);
    },
  };
}

describe("processInstantlyInboundReply", () => {
  it("replay persists one message, creates one draft, and calls the LLM once", async () => {
    const store = storeFixture();
    const provider = new MockLLMProvider();
    const llmProvider: LLMProvider = {
      providerName: provider.providerName,
      classifyAndDraft: vi.fn((context) => provider.classifyAndDraft(context)),
    };
    const providerFactory = vi.fn(() => llmProvider);

    const first = await processInstantlyInboundReply(event, "hash", store, new Date(event.occurredAt), providerFactory);
    const replay = await processInstantlyInboundReply(event, "hash", store, new Date(event.occurredAt), providerFactory);

    expect(first.outcome).toBe("processed");
    expect(replay.outcome).toBe("duplicate_skipped");
    expect(store.persistCount).toBe(1);
    expect(store.drafts).toHaveLength(1);
    expect(llmProvider.classifyAndDraft).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is suppressed before the provider factory or LLM is used", async () => {
    const store = storeFixture();
    const providerFactory = vi.fn(() => new MockLLMProvider());
    const result = await processInstantlyInboundReply(
      { ...event, providerEventId: "event-stop", providerMessageId: "message-stop", body: "Please unsubscribe" },
      "hash-stop",
      store,
      new Date(event.occurredAt),
      providerFactory,
    );
    expect(result.outcome).toBe("processed");
    expect(providerFactory).not.toHaveBeenCalled();
    expect(store.drafts).toHaveLength(0);
    expect(store.statuses).toContain("suppressed");
  });

  it("a provider failure keeps the incoming message and persists a human-required draft", async () => {
    const store = storeFixture();
    const failedProvider: LLMProvider = {
      providerName: "down",
      async classifyAndDraft() {
        throw new Error("unavailable");
      },
    };
    const result = await processInstantlyInboundReply(event, "hash", store, new Date(event.occurredAt), () => failedProvider);
    expect(result.outcome).toBe("processed");
    expect(store.persistCount).toBe(1);
    expect(store.drafts).toHaveLength(1);
    expect(store.statuses).toContain("pending_review");
  });
});