import { describe, expect, it } from "vitest";
import type { SetterPromptContext } from "@/domain/providers/types";
import { applyGuardrails } from "./guardrails";
import type { ValidatedSetterOutput } from "./setter-output-schema";

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
      forbiddenClaims: ["therapeutic_claims", "certification_claims"],
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
    ...overrides,
  };
}

function outputFixture(overrides: Partial<ValidatedSetterOutput> = {}): ValidatedSetterOutput {
  return {
    language: "es",
    branch: "INTEREST",
    intentSummary: "Lead wants more info",
    confidence: 0.8,
    draft: "Gracias por su interés, le paso más información.",
    needsHuman: false,
    reasonForHuman: null,
    detectedFactsRequested: [],
    riskFlags: [],
    suggestedNextAction: "send_info",
    ...overrides,
  };
}

describe("applyGuardrails", () => {
  it("does not escalate a clean draft with no restricted topics", () => {
    const result = applyGuardrails(outputFixture(), contextFixture());
    expect(result.triggered).toEqual([]);
    expect(result.output.needsHuman).toBe(false);
  });

  it("escalates when the draft makes a forbidden therapeutic claim", () => {
    const result = applyGuardrails(outputFixture({ draft: "Este producto cura la fatiga crónica." }), contextFixture());
    expect(result.triggered).toContain("medical_therapeutic_claim");
    expect(result.output.needsHuman).toBe(true);
    expect(result.output.riskFlags).toContain("medical_therapeutic_claim");
  });

  it("does not escalate a claim category not listed in forbiddenClaims", () => {
    const result = applyGuardrails(
      outputFixture({ draft: "Nuestro rendimiento de farmacia es excelente." }),
      contextFixture({ offer: { ...contextFixture().offer, forbiddenClaims: ["therapeutic_claims"] } }),
    );
    expect(result.triggered).not.toContain("pharmacy_performance_claim");
  });

  it("escalates a pricing claim that is not grounded in approved commercial facts", () => {
    const result = applyGuardrails(outputFixture({ draft: "El precio especial para usted es de 10€." }), contextFixture());
    expect(result.triggered).toContain("pricing_claim");
    expect(result.output.needsHuman).toBe(true);
  });

  it("does not escalate a minimum-order claim that is grounded in approved commercial facts", () => {
    const result = applyGuardrails(outputFixture({ draft: "Nuestro pedido mínimo es de 24 unidades." }), contextFixture());
    expect(result.triggered).not.toContain("minimum_order_claim");
  });

  it("escalates to human when the lead requests non-approved commercial negotiation terms", () => {
    const result = applyGuardrails(
      outputFixture(),
      contextFixture({ latestIncomingMessage: "Podemos tener un territorio exclusivo y un gran volumen de descuento?" }),
    );
    expect(result.triggered).toContain("commercial_negotiation_requires_human");
    expect(result.output.needsHuman).toBe(true);
    expect(result.output.reasonForHuman).not.toBeNull();
  });

  it("preserves existing risk flags and dedupes", () => {
    const result = applyGuardrails(
      outputFixture({ riskFlags: ["medical_therapeutic_claim"], draft: "Este producto cura la fatiga crónica." }),
      contextFixture(),
    );
    expect(result.output.riskFlags.filter((flag) => flag === "medical_therapeutic_claim").length).toBe(1);
  });
});
