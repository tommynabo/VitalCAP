import { describe, expect, it } from "vitest";
import type { Account } from "@/domain/accounts/types";
import type { Offer } from "@/domain/campaigns/types";
import type { Contact } from "@/domain/contacts/types";
import type { ConversationMessage, SetterFeedback } from "@/domain/conversations/types";
import { buildSetterContext } from "./context-builder";

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
    faq: [{ question: "MOQ?", answer: "24 units" }],
    objectionGuidance: { price: "Emphasize margin, not discount" },
    toneConfig: { voice: "warm_professional" },
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

function contactFixture(): Contact {
  return {
    id: "contact-1",
    workspaceId: "ws-1",
    accountId: "acc-1",
    firstName: "Maria",
    lastName: "Lopez",
    fullName: "Maria Lopez",
    jobTitle: "Titular",
    roleType: "titular_pharmacist",
    isDecisionMaker: true,
    seniority: "owner",
    linkedinUrl: null,
    sourceConfidence: 0.9,
    status: "active",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function messageFixture(index: number): ConversationMessage {
  return {
    id: `msg-${index}`,
    conversationId: "conv-1",
    direction: index % 2 === 0 ? "outgoing" : "incoming",
    body: `Message body ${index}`,
    channel: "email",
    providerMessageId: `provider-${index}`,
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function feedbackFixture(note: string | null): SetterFeedback {
  return {
    id: "fb-1",
    conversationMessageId: "msg-1",
    predictedBranch: "PRICE",
    correctedBranch: null,
    aiDraft: "draft",
    correctedText: null,
    decision: "approve",
    reasonCategory: null,
    note,
    meetingOutcome: null,
    qualified: null,
    lostReason: null,
    reviewedAt: "2024-01-01T00:00:00.000Z",
    reviewerId: "reviewer-1",
  };
}

describe("buildSetterContext", () => {
  it("whitelists only approved offer facts and no unrelated data", () => {
    const context = buildSetterContext({
      offer: offerFixture(),
      account: accountFixture(),
      contact: contactFixture(),
      discoverySource: "maps_fast",
      conversationMessages: [messageFixture(1)],
      recentFeedback: [],
      latestIncomingMessage: "Que precio tienen?",
      language: "es",
    });

    expect(context.offer.forbiddenClaims).toContain("therapeutic_claims");
    expect(context.offer.approvedClaims).toEqual(["made_in_spain"]);
    expect(context.account.name).toBe("Farmacia Central");
    expect(context.contact?.roleType).toBe("titular_pharmacist");
    expect(context.discoverySource).toBe("maps_fast");
    expect(Object.keys(context)).not.toContain("rawAccount");
  });

  it("caps conversation history to the most recent messages", () => {
    const messages = Array.from({ length: 25 }, (_, i) => messageFixture(i));
    const context = buildSetterContext({
      offer: offerFixture(),
      account: accountFixture(),
      contact: null,
      discoverySource: null,
      conversationMessages: messages,
      recentFeedback: [],
      latestIncomingMessage: "hello",
      language: "es",
    });

    expect(context.recentMessages.length).toBe(10);
    expect(context.recentMessages[context.recentMessages.length - 1]?.body).toBe("Message body 24");
  });

  it("caps recent feedback notes and drops null notes", () => {
    const feedback = [
      feedbackFixture(null),
      feedbackFixture("Correction 1"),
      feedbackFixture("Correction 2"),
      feedbackFixture("Correction 3"),
      feedbackFixture("Correction 4"),
      feedbackFixture("Correction 5"),
      feedbackFixture("Correction 6"),
    ];
    const context = buildSetterContext({
      offer: offerFixture(),
      account: accountFixture(),
      contact: null,
      discoverySource: null,
      conversationMessages: [],
      recentFeedback: feedback,
      latestIncomingMessage: "hello",
      language: "es",
    });

    expect(context.recentFeedbackNotes.length).toBe(5);
    expect(context.recentFeedbackNotes).not.toContain(null);
  });
});
