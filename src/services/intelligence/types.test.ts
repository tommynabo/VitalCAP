import { describe, expect, it } from "vitest";
import {
  fitTierForScore,
  normalizeProspectAnalysis,
  ProspectAnalysisOutputSchema,
} from "./types";

function analysisOutput(overrides: Record<string, unknown> = {}) {
  return {
    businessType: "pharmacy",
    fitScore: 92,
    fitTier: "high",
    confidence: 0.94,
    qualified: true,
    qualificationRecommendation: "qualify",
    qualificationReason: "Matches the configured pharmacy ICP.",
    reasonSummary: "Spanish pharmacy with strong evidence of the target business type.",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    positiveSignals: ["Pharmacy category", "Active website"],
    negativeSignals: [],
    supplementSignals: [],
    decisionMakerSignals: [],
    personalizationFacts: [],
    suggestedAngle: "Discuss the configured pharmacy offer.",
    dataQualityScore: 90,
    missingInformation: [],
    nextEnrichmentActions: [],
    riskFlags: [],
    needsHumanReview: false,
    ...overrides,
  };
}

describe("prospect analysis output", () => {
  it("accepts a strong ICP result as a high structured score", () => {
    const parsed = ProspectAnalysisOutputSchema.parse(analysisOutput());

    expect(parsed.fitScore).toBeGreaterThanOrEqual(80);
    expect(parsed.fitTier).toBe("high");
    expect(parsed.qualificationRecommendation).toBe("qualify");
  });

  it("keeps a weak ICP below the high-fit tier", () => {
    const parsed = ProspectAnalysisOutputSchema.parse(analysisOutput({
      businessType: "other_retail",
      fitScore: 28,
      fitTier: "low",
      qualified: false,
      qualificationRecommendation: "disqualify",
      positiveSignals: [],
      negativeSignals: ["Outside the primary ICP"],
    }));

    expect(parsed.fitScore).toBeLessThan(60);
    expect(fitTierForScore(parsed.fitScore)).toBe("low");
  });

  it("normalizes a model tier that disagrees with its score", () => {
    const parsed = ProspectAnalysisOutputSchema.parse(analysisOutput({ fitScore: 55 }));

    expect(normalizeProspectAnalysis(parsed).fitTier).toBe("low");
  });
});