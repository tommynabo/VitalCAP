import { describe, expect, it } from "vitest";
import type { LLMProvider, SetterClassificationOutput, SetterPromptContext } from "@/domain/providers/types";
import { emptyProviderUsageStats } from "@/domain/providers/types";
import { classifyAndDraft } from "./classify-and-draft";

function contextFixture(): SetterPromptContext {
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
    latestIncomingMessage: "Que precio tienen?",
    isRepairAttempt: false,
  };
}

function validOutput(): SetterClassificationOutput {
  return {
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
  };
}

class QueuedFakeProvider implements LLMProvider {
  readonly providerName = "fake";
  private readonly queue: unknown[];

  constructor(outputs: unknown[]) {
    this.queue = [...outputs];
  }

  async classifyAndDraft(_context: SetterPromptContext): ReturnType<LLMProvider["classifyAndDraft"]> {
    const next = this.queue.shift();
    return { output: next as SetterClassificationOutput, usage: emptyProviderUsageStats() };
  }
}

describe("classifyAndDraft", () => {
  it("returns the validated draft on the first successful call", async () => {
    const provider = new QueuedFakeProvider([validOutput()]);
    const result = await classifyAndDraft(provider, contextFixture());
    expect(result.retried).toBe(false);
    expect(result.validationFailed).toBe(false);
    expect(result.draft.branch).toBe("PRICE");
  });

  it("retries once with a repair attempt after an invalid first output, then succeeds", async () => {
    const invalid = { ...validOutput(), confidence: 5 };
    const provider = new QueuedFakeProvider([invalid, validOutput()]);
    const result = await classifyAndDraft(provider, contextFixture());
    expect(result.retried).toBe(true);
    expect(result.validationFailed).toBe(false);
    expect(result.draft.branch).toBe("PRICE");
  });

  it("falls back to a HUMAN_REQUIRED draft when both attempts are invalid", async () => {
    const invalid = { ...validOutput(), branch: "NOT_A_BRANCH" };
    const provider = new QueuedFakeProvider([invalid, invalid]);
    const result = await classifyAndDraft(provider, contextFixture());
    expect(result.retried).toBe(true);
    expect(result.validationFailed).toBe(true);
    expect(result.draft.branch).toBe("HUMAN_REQUIRED");
    expect(result.draft.needsHuman).toBe(true);
    expect(result.draft.riskFlags).toContain("invalid_llm_output");
  });

  it("applies guardrails to a valid but risky draft", async () => {
    const risky: SetterClassificationOutput = { ...validOutput(), draft: "Este producto cura la fatiga crónica." };
    const provider = new QueuedFakeProvider([risky]);
    const result = await classifyAndDraft(provider, contextFixture());
    expect(result.draft.needsHuman).toBe(true);
    expect(result.draft.riskFlags).toContain("medical_therapeutic_claim");
  });
});
