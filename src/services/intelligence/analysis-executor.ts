import {
  normalizeProspectAnalysis,
  ProspectAnalysisOutput,
  ProspectAnalysisOutputSchema,
  ProspectContext,
} from "./types";

export interface AnalysisRepairRequest {
  issues: string[];
  invalidOutput: string | null;
}

export interface AnalysisAttemptResponse {
  output: unknown;
  rawOutput?: string | null;
}

export interface ExecutedProspectAnalysis {
  output: ProspectAnalysisOutput;
  attempts: number;
  fallbackReason: string | null;
}

function outputValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function evidenceIssues(output: ProspectAnalysisOutput, context: ProspectContext): string[] {
  const validIds = new Set(context.evidence.map((fact) => fact.id));
  const referencedIds = [
    ...output.supportingEvidenceIds,
    ...output.contradictingEvidenceIds,
    ...output.personalizationFacts.flatMap((fact) => fact.evidenceIds),
  ];
  const unknownIds = [...new Set(referencedIds.filter((id) => !validIds.has(id)))];
  return unknownIds.length > 0 ? [`Unknown evidence IDs: ${unknownIds.slice(0, 5).join(", ")}`] : [];
}

function safeFallback(context: ProspectContext): ProspectAnalysisOutput {
  return {
    businessType: context.account.businessType,
    fitScore: 0,
    fitTier: "low",
    confidence: 0,
    qualified: false,
    qualificationRecommendation: "review",
    qualificationReason: "The model response did not pass structured validation.",
    reasonSummary: "Analysis needs human review because no validated result was produced.",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    positiveSignals: [],
    negativeSignals: [],
    supplementSignals: [],
    decisionMakerSignals: [],
    personalizationFacts: [],
    suggestedAngle: "",
    dataQualityScore: 0,
    missingInformation: ["Validated intelligence result"],
    nextEnrichmentActions: [],
    riskFlags: ["invalid_model_output"],
    needsHumanReview: true,
  };
}

export async function executeProspectAnalysis(
  context: ProspectContext,
  request: (repair: AnalysisRepairRequest | null) => Promise<AnalysisAttemptResponse>,
): Promise<ExecutedProspectAnalysis> {
  let repair: AnalysisRepairRequest | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await request(repair);
    const parsed = ProspectAnalysisOutputSchema.safeParse(outputValue(response.output));
    const issues = parsed.success
      ? evidenceIssues(parsed.data, context)
      : parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

    if (parsed.success && issues.length === 0) {
      return { output: normalizeProspectAnalysis(parsed.data), attempts: attempt, fallbackReason: null };
    }

    repair = {
      issues: issues.length > 0 ? issues : ["Output was not valid JSON matching the required schema."],
      invalidOutput: response.rawOutput?.slice(0, 8_000) ?? null,
    };
  }

  return {
    output: safeFallback(context),
    attempts: 2,
    fallbackReason: repair?.issues.join("; ").slice(0, 1_000) ?? "Invalid model output",
  };
}