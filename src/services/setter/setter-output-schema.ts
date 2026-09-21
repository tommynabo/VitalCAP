import { z } from "zod";
import type { SetterBranch } from "@/domain/conversations/types";

/**
 * Strict Zod validation of LLM structured output (Prompt 4 §4.5). The
 * domain-level `SetterClassificationOutput.branch` is a loose `string` (the
 * domain layer must not depend on Zod), but every response is re-validated
 * here against the actual branch catalog before it's trusted anywhere else.
 */
const BRANCH_VALUES = [
  "INTEREST",
  "SEND_INFO",
  "MARGIN",
  "PRICE",
  "MINIMUM_ORDER",
  "PRODUCT_DETAILS",
  "EXISTING_SUPPLIER",
  "SAMPLES",
  "CREDIBILITY",
  "NOT_DECISION_MAKER",
  "FORWARD_TO_PURCHASING",
  "CALL_ME_LATER",
  "MEETING_REQUEST",
  "LOGISTICS",
  "COMMERCIAL_TERMS",
  "NOT_INTERESTED",
  "UNSUBSCRIBE",
  "UNKNOWN",
  "HUMAN_REQUIRED",
] as const satisfies readonly SetterBranch[];

export const setterOutputSchema = z.object({
  language: z.string().min(1),
  branch: z.enum(BRANCH_VALUES),
  intentSummary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  draft: z.string().min(1),
  needsHuman: z.boolean(),
  reasonForHuman: z.string().nullable(),
  detectedFactsRequested: z.array(z.string()),
  riskFlags: z.array(z.string()),
  suggestedNextAction: z.string().min(1),
});

export type ValidatedSetterOutput = z.infer<typeof setterOutputSchema>;

export interface SetterOutputValidation {
  success: boolean;
  data: ValidatedSetterOutput | null;
  errorSummary: string | null;
}

export function validateSetterOutput(raw: unknown): SetterOutputValidation {
  const parsed = setterOutputSchema.safeParse(raw);
  if (parsed.success) {
    return { success: true, data: parsed.data, errorSummary: null };
  }
  return { success: false, data: null, errorSummary: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}
