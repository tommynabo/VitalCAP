import { describe, expect, it } from "vitest";
import type { Account } from "@/domain/accounts/types";
import type { Offer } from "@/domain/campaigns/types";
import type { Conversation, ConversationMessage } from "@/domain/conversations/types";
import type { SuppressionEntry } from "@/domain/outreach/types";
import { checkSuppression } from "@/services/compliance/suppression-service";
import { MockLLMProvider } from "@/infrastructure/providers/llm/mock-provider";
import { applyReviewDecision } from "./review-service";
import { ingestIncomingReply } from "./reply-ingestion";
import { processIncomingReply } from "./setter-orchestrator";
import { enterWarmFollowupQueue } from "./warm-followup-service";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

function offerFixture(): Offer {
  return {
    id: "offer-1",
    workspaceId: "ws-1",
    name: "Vitalcap Line",
    company: "Vitalcap",
    description: "Supplement line for pharmacies",
    primaryCta: "book_meeting",
    bookingUrl: "https://cal.example.com/vitalcap",
    approvedCommercialFacts: { minOrderUnits: 24 },
    approvedProductFacts: { formats: ["capsule"] },
    approvedClaims: ["made_in_spain"],
    forbiddenClaims: ["therapeutic_claims"],
    faq: [],
    objectionGuidance: {},
    toneConfig: {},
    active: true,
  };
}

function accountFixture(): Account {
  return {
    id: "acc-1",
    workspaceId: "ws-1",
    canonicalName: "Farmacia Central",
    normalizedName: "farmacia central",
    businessType: "pharmacy",
    countryCode: "ES",
    region: null,
    province: null,
    city: null,
    postalCode: null,
    addressLine: null,
    normalizedAddress: null,
    latitude: null,
    longitude: null,
    phone: null,
    normalizedPhone: null,
    websiteUrl: null,
    normalizedDomain: null,
    googlePlaceId: null,
    mapsUrl: null,
    rating: null,
    reviewCount: null,
    fitScore: null,
    fitTier: "unscored",
    status: "outreach_ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function conversation(): Conversation {
  return {
    id: "conv-1",
    workspaceId: "ws-1",
    accountId: "acc-1",
    contactId: null,
    campaignId: "camp-1",
    offerId: "offer-1",
    channel: "email",
    providerThreadId: "thread-1",
    state: "reply_received",
    latestIntent: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function incomingMessage(body: string): ConversationMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    direction: "incoming",
    body,
    channel: "email",
    providerMessageId: "provider-msg-1",
    metadata: {},
    createdAt: "2024-01-02T00:00:00.000Z",
  };
}

describe("simulate a day of AI Setter activity", () => {
  it("ingests a reply idempotently and never duplicates it on retry", () => {
    const first = ingestIncomingReply(
      [],
      [],
      {
        workspaceId: "ws-1",
        accountId: "acc-1",
        contactId: null,
        campaignId: "camp-1",
        offerId: "offer-1",
        channel: "email",
        providerThreadId: "thread-1",
        providerMessageId: "provider-msg-1",
        body: "Que precio tienen?",
        occurredAt: "2024-01-02T00:00:00.000Z",
      },
      nextId,
    );
    // Replaying the exact same webhook payload again must be a no-op.
    const secondCall = ingestIncomingReply(
      first.conversations,
      first.messages,
      {
        workspaceId: "ws-1",
        accountId: "acc-1",
        contactId: null,
        campaignId: "camp-1",
        offerId: "offer-1",
        channel: "email",
        providerThreadId: "thread-1",
        providerMessageId: "provider-msg-1",
        body: "Que precio tienen?",
        occurredAt: "2024-01-02T00:00:00.000Z",
      },
      nextId,
    );
    expect(secondCall.outcome).toBe("duplicate_skipped");
    expect(secondCall.messages).toHaveLength(1);
  });

  it("suppresses an unsubscribe reply without ever invoking the LLM", async () => {
    const provider = new MockLLMProvider();
    let llmCalls = 0;
    const spyProvider = {
      providerName: provider.providerName,
      classifyAndDraft: async (context: Parameters<typeof provider.classifyAndDraft>[0]) => {
        llmCalls += 1;
        return provider.classifyAndDraft(context);
      },
    };

    const result = await processIncomingReply({
      workspaceId: "ws-1",
      conversation: conversation(),
      incomingMessage: incomingMessage("Por favor, dadme de baja de esta lista."),
      conversationMessages: [incomingMessage("Por favor, dadme de baja de esta lista.")],
      offer: offerFixture(),
      account: accountFixture(),
      contact: null,
      discoverySource: "maps_fast",
      recentFeedback: [],
      suppressionEntries: [],
      contactPointId: "cp-1",
      llmProvider: spyProvider,
      now: new Date("2024-01-02T00:00:00.000Z"),
    });

    expect(llmCalls).toBe(0);
    expect(result.usedLLM).toBe(false);
    expect(result.conversation.state).toBe("suppressed");
    expect(result.suppressionEntries).toHaveLength(1);

    const check = checkSuppression({ contactPointId: "cp-1", accountId: "acc-1" }, result.suppressionEntries);
    expect(check.suppressed).toBe(true);
  });

  it("never lets the LLM override an existing suppression entry", async () => {
    const existingSuppression: SuppressionEntry = {
      id: "sup-1",
      workspaceId: "ws-1",
      contactPointId: "cp-1",
      accountId: null,
      reason: "unsubscribe",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    const result = await processIncomingReply({
      workspaceId: "ws-1",
      conversation: conversation(),
      incomingMessage: incomingMessage("Nos interesa saber más sobre precios."),
      conversationMessages: [incomingMessage("Nos interesa saber más sobre precios.")],
      offer: offerFixture(),
      account: accountFixture(),
      contact: null,
      discoverySource: "maps_fast",
      recentFeedback: [],
      suppressionEntries: [existingSuppression],
      contactPointId: "cp-1",
      llmProvider: new MockLLMProvider(),
      now: new Date("2024-01-02T00:00:00.000Z"),
    });

    expect(result.usedLLM).toBe(false);
    expect(result.conversation.state).toBe("suppressed");
  });

  it("runs the full classify -> draft -> review -> approve flow and enters warm follow-up", async () => {
    const result = await processIncomingReply({
      workspaceId: "ws-1",
      conversation: conversation(),
      incomingMessage: incomingMessage("Nos interesa saber más sobre el producto."),
      conversationMessages: [incomingMessage("Nos interesa saber más sobre el producto.")],
      offer: offerFixture(),
      account: accountFixture(),
      contact: null,
      discoverySource: "maps_fast",
      recentFeedback: [],
      suppressionEntries: [],
      contactPointId: "cp-1",
      llmProvider: new MockLLMProvider(),
      now: new Date("2024-01-02T00:00:00.000Z"),
    });

    expect(result.usedLLM).toBe(true);
    expect(result.draft).not.toBeNull();
    expect(result.conversation.state).toBe("pending_review");

    const fullDraft = { ...result.draft!, id: "draft-1", conversationMessageId: "msg-1", createdAt: "2024-01-02T00:00:00.000Z" };
    const review = applyReviewDecision(
      {
        draft: fullDraft,
        conversation: result.conversation,
        decision: "approve",
        finalText: null,
        correctionReason: null,
        correctedBranch: null,
        reviewerId: "reviewer-1",
        reviewedAt: "2024-01-02T01:00:00.000Z",
      },
      nextId,
    );
    expect(review.conversation.state).toBe("sent");
    expect(review.outgoingMessage).not.toBeNull();

    const warmItem = enterWarmFollowupQueue(review.conversation.id, fullDraft.branch, false, "2024-01-02T01:00:00.000Z", nextId);
    expect(warmItem?.status).toBe("active");
  });

  it("escalates a guardrail-triggered draft to human review instead of auto-approving", async () => {
    const provider = new MockLLMProvider();
    const forcedRiskyProvider = {
      providerName: provider.providerName,
      classifyAndDraft: async () => ({
        output: {
          language: "es",
          branch: "INTEREST" as const,
          intentSummary: "Lead interested",
          confidence: 0.9,
          draft: "Este producto cura la fatiga crónica y tiene certificación garantizada.",
          needsHuman: false,
          reasonForHuman: null,
          detectedFactsRequested: [],
          riskFlags: [],
          suggestedNextAction: "send_info",
        },
        usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 10, costUsd: 0, quotaRemaining: null },
      }),
    };

    const result = await processIncomingReply({
      workspaceId: "ws-1",
      conversation: conversation(),
      incomingMessage: incomingMessage("Cuéntame más del producto"),
      conversationMessages: [incomingMessage("Cuéntame más del producto")],
      offer: offerFixture(),
      account: accountFixture(),
      contact: null,
      discoverySource: "maps_fast",
      recentFeedback: [],
      suppressionEntries: [],
      contactPointId: "cp-1",
      llmProvider: forcedRiskyProvider,
      now: new Date("2024-01-02T00:00:00.000Z"),
    });

    expect(result.draft?.needsHuman).toBe(true);
    expect(result.draft?.riskFlags).toContain("medical_therapeutic_claim");
  });
});
