import { describe, expect, it } from "vitest";
import type { SetterPromptContext } from "@/domain/providers/types";
import { MockLLMProvider } from "./mock-provider";

function contextFixture(overrides: Partial<SetterPromptContext> = {}): SetterPromptContext {
  return {
    language: "es",
    offer: {
      company: "Vitalcap",
      description: "Supplement line",
      primaryCta: "book_meeting",
      bookingUrl: "https://cal.example.com/vitalcap",
      approvedCommercialFacts: { minOrderUnits: 24 },
      approvedProductFacts: { formats: ["capsule"] },
      approvedClaims: ["made_in_spain"],
      forbiddenClaims: ["therapeutic_claims"],
      faq: [],
      objectionGuidance: {},
      toneConfig: {},
    },
    account: { name: "Farmacia Central", businessType: "pharmacy" },
    contact: null,
    discoverySource: null,
    recentMessages: [],
    recentFeedbackNotes: [],
    latestIncomingMessage: "Nos interesa saber más",
    isRepairAttempt: false,
    ...overrides,
  };
}

describe("MockLLMProvider", () => {
  it("classifies a price question as PRICE and does not require human", async () => {
    const provider = new MockLLMProvider();
    const { output } = await provider.classifyAndDraft(contextFixture({ latestIncomingMessage: "Que precio tienen?" }));
    expect(output.branch).toBe("PRICE");
    expect(output.needsHuman).toBe(false);
    expect(output.draft.length).toBeGreaterThan(0);
  });

  it("classifies a meeting request as MEETING_REQUEST", async () => {
    const provider = new MockLLMProvider();
    const { output } = await provider.classifyAndDraft(contextFixture({ latestIncomingMessage: "Podemos agendar una llamada?" }));
    expect(output.branch).toBe("MEETING_REQUEST");
  });

  it("flags commercial negotiation asks as needing a human", async () => {
    const provider = new MockLLMProvider();
    const { output } = await provider.classifyAndDraft(
      contextFixture({ latestIncomingMessage: "Necesitamos un territorio exclusivo con gran volumen." }),
    );
    expect(output.branch).toBe("COMMERCIAL_TERMS");
    expect(output.needsHuman).toBe(true);
    expect(output.reasonForHuman).not.toBeNull();
  });

  it("falls back to UNKNOWN with needsHuman true for unrecognized text", async () => {
    const provider = new MockLLMProvider();
    const { output } = await provider.classifyAndDraft(contextFixture({ latestIncomingMessage: "asdkjaslkdj random text" }));
    expect(output.branch).toBe("UNKNOWN");
    expect(output.needsHuman).toBe(true);
  });

  it("produces a deterministic confidence for the same input", async () => {
    const provider = new MockLLMProvider();
    const context = contextFixture({ latestIncomingMessage: "Que precio tienen?" });
    const first = await provider.classifyAndDraft(context);
    const second = await provider.classifyAndDraft(context);
    expect(first.output.confidence).toBe(second.output.confidence);
  });

  it("never mentions a fact outside the whitelisted offer context", async () => {
    const provider = new MockLLMProvider();
    const { output } = await provider.classifyAndDraft(contextFixture({ latestIncomingMessage: "Que precio tienen?" }));
    expect(output.draft).not.toMatch(/\d+\s*%/);
  });
});
