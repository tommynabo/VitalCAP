import { describe, expect, it, vi } from "vitest";
import { hashProspectContext, type ProspectAnalysisOutput, type ProspectContext } from "./types";
import { executeProspectAnalysis } from "./analysis-executor";

const context: ProspectContext = {
  workspaceId: "workspace-1",
  campaignId: "campaign-1",
  accountId: "account-1",
  account: {
    id: "account-1",
    normalizedName: "farmacia central",
    normalizedDomain: "farmacia.example",
    businessType: "pharmacy",
    location: { city: "Madrid", region: "Madrid", country: "ES" },
    metrics: { rating: 4.7, reviewCount: 120 },
  },
  offer: {
    name: "Offer",
    company: "VitalCap",
    description: "Configured offer",
    primaryCta: "Book a call",
    approvedClaims: [],
    forbiddenClaims: [],
    icpCriteria: {
      targetBusinessTypes: ["pharmacy"],
      inclusionCriteria: [],
      exclusionCriteria: [],
    },
  },
  campaign: { name: "Campaign", description: null, minimumFitScore: null },
  evidence: [{ id: "evidence-1", type: "maps_signal", value: "Pharmacy", sourceUrl: null, snippet: null }],
  contacts: [],
  contactPoints: [],
};

const validOutput: ProspectAnalysisOutput = {
  businessType: "pharmacy",
  fitScore: 92,
  fitTier: "high",
  confidence: 0.94,
  qualified: true,
  qualificationRecommendation: "qualify",
  qualificationReason: "Matches the configured target business type.",
  reasonSummary: "Strong pharmacy ICP match with verified category evidence.",
  supportingEvidenceIds: ["evidence-1"],
  contradictingEvidenceIds: [],
  positiveSignals: ["Target pharmacy business type"],
  negativeSignals: [],
  supplementSignals: [],
  decisionMakerSignals: [],
  personalizationFacts: [],
  suggestedAngle: "Discuss the configured offer.",
  dataQualityScore: 90,
  missingInformation: [],
  nextEnrichmentActions: [],
  riskFlags: [],
  needsHumanReview: false,
};

describe("executeProspectAnalysis", () => {
  it("repairs invalid output once and accepts the repaired structured result", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ output: { fitScore: "not a score" }, rawOutput: "{broken" })
      .mockResolvedValueOnce({ output: validOutput });

    const result = await executeProspectAnalysis(context, request);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]?.issues.length).toBeGreaterThan(0);
    expect(result.output.fitTier).toBe("high");
    expect(result.fallbackReason).toBeNull();
  });

  it("returns a low-score human-review fallback after two invalid outputs", async () => {
    const result = await executeProspectAnalysis(context, async () => ({ output: { fitScore: 110 } }));

    expect(result.attempts).toBe(2);
    expect(result.output.fitScore).toBe(0);
    expect(result.output.fitTier).toBe("low");
    expect(result.output.qualificationRecommendation).toBe("review");
    expect(result.output.needsHumanReview).toBe(true);
    expect(result.output.riskFlags).toContain("invalid_model_output");
    expect(result.fallbackReason).toBeTruthy();
  });

  it("propagates provider failures so the queue can defer the job", async () => {
    await expect(executeProspectAnalysis(context, async () => {
      throw new Error("provider unavailable");
    })).rejects.toThrow("provider unavailable");
  });

  it("rejects references to evidence outside the supplied context", async () => {
    const result = await executeProspectAnalysis(context, async () => ({
      output: { ...validOutput, supportingEvidenceIds: ["untrusted-id"] },
    }));

    expect(result.output.qualificationRecommendation).toBe("review");
    expect(result.output.riskFlags).toContain("invalid_model_output");
  });

  it("keeps unchanged evidence idempotent and permits analysis after evidence changes", () => {
    const unchangedContext = structuredClone(context);
    const changedContext = structuredClone(context);
    changedContext.evidence[0]!.value = "Pharmacy and parapharmacy";

    expect(hashProspectContext(context)).toBe(hashProspectContext(unchangedContext));
    expect(hashProspectContext(context)).not.toBe(hashProspectContext(changedContext));
  });
});