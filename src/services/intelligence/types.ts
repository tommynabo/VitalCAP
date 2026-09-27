import { z } from "zod";
import { createHash } from "node:crypto";

export const EvidenceFactSchema = z.object({
  id: z.string(),
  type: z.string(),
  value: z.string(),
  sourceUrl: z.string().nullable(),
  snippet: z.string().nullable(),
});

export type EvidenceFact = z.infer<typeof EvidenceFactSchema>;

export const ProspectContextSchema = z.object({
  workspaceId: z.string(),
  campaignId: z.string(),
  accountId: z.string(),
  account: z.object({
    id: z.string(),
    normalizedName: z.string(),
    normalizedDomain: z.string().nullable(),
    businessType: z.string(),
    location: z.object({
      city: z.string().nullable(),
      region: z.string().nullable(),
      country: z.string().nullable(),
    }),
    metrics: z.object({
      rating: z.number().nullable(),
      reviewCount: z.number().nullable(),
    }),
  }),
  offer: z.object({
    name: z.string(),
    company: z.string(),
    description: z.string(),
    primaryCta: z.string(),
    approvedClaims: z.array(z.string()),
    forbiddenClaims: z.array(z.string()),
  }),
  campaign: z.object({
    name: z.string(),
    description: z.string().nullable(),
  }),
  evidence: z.array(EvidenceFactSchema),
  contactPoints: z.array(z.object({
    id: z.string(),
    channel: z.string(),
    title: z.string().nullable(),
    name: z.string().nullable(),
  })),
});

export type ProspectContext = z.infer<typeof ProspectContextSchema>;

export function hashProspectContext(context: ProspectContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

export const PersonalizationFactSchema = z.object({
  fact: z.string(),
  evidenceIds: z.array(z.string()),
});

export const ProspectAnalysisOutputSchema = z.object({
  businessType: z.string(),
  fitScore: z.number().min(0).max(100),
  fitTier: z.string(),
  confidence: z.number().min(0).max(1),
  qualified: z.boolean(),
  qualificationReason: z.string(),
  positiveSignals: z.array(z.string()),
  negativeSignals: z.array(z.string()),
  supplementSignals: z.array(z.string()),
  decisionMakerSignals: z.array(z.string()),
  personalizationFacts: z.array(PersonalizationFactSchema),
  suggestedAngle: z.string(),
  dataQualityScore: z.number().min(0).max(100),
  missingInformation: z.array(z.string()),
  nextEnrichmentActions: z.array(z.string()),
  riskFlags: z.array(z.string()),
  needsHumanReview: z.boolean(),
});

export type ProspectAnalysisOutput = z.infer<typeof ProspectAnalysisOutputSchema>;
