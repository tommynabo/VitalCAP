import type { SetterBranch, SetterDraft } from "@/domain/conversations/types";
import type { LLMProvider, SetterPromptContext } from "@/domain/providers/types";
import { applyGuardrails } from "./guardrails";
import { validateSetterOutput } from "./setter-output-schema";

/**
 * Classify-and-draft orchestration (Prompt 4 §4.5). Calls the LLM provider,
 * validates the structured output with Zod, retries once with a repair
 * flag on failure, and otherwise falls back to a `HUMAN_REQUIRED` draft
 * state rather than ever trusting an invalid shape. A successful,
 * validated output is still passed through the guardrails (§4.6) before
 * being treated as a usable draft.
 */
export type DraftFields = Omit<SetterDraft, "id" | "conversationMessageId" | "createdAt">;

export interface ClassifyAndDraftResult {
  draft: DraftFields;
  retried: boolean;
  validationFailed: boolean;
}

function humanRequiredFallback(context: SetterPromptContext, reason: string): DraftFields {
  return {
    language: context.language,
    branch: "HUMAN_REQUIRED" satisfies SetterBranch,
    intentSummary: "LLM output failed structured validation.",
    confidence: 0,
    draft: "",
    needsHuman: true,
    reasonForHuman: reason,
    detectedFactsRequested: [],
    riskFlags: ["invalid_llm_output"],
    suggestedNextAction: "manual_human_draft",
  };
}

export async function classifyAndDraft(provider: LLMProvider, context: SetterPromptContext): Promise<ClassifyAndDraftResult> {
  let retried = false;
  const first = await provider.classifyAndDraft(context);
  let validation = validateSetterOutput(first.output);

  if (!validation.success) {
    retried = true;
    const retry = await provider.classifyAndDraft({ ...context, isRepairAttempt: true });
    validation = validateSetterOutput(retry.output);
  }

  if (!validation.success || !validation.data) {
    return {
      draft: humanRequiredFallback(context, `Invalid LLM output after retry: ${validation.errorSummary ?? "unknown error"}`),
      retried,
      validationFailed: true,
    };
  }

  const guarded = applyGuardrails(validation.data, context);

  return {
    draft: {
      language: guarded.output.language,
      branch: guarded.output.branch,
      intentSummary: guarded.output.intentSummary,
      confidence: guarded.output.confidence,
      draft: guarded.output.draft,
      needsHuman: guarded.output.needsHuman,
      reasonForHuman: guarded.output.reasonForHuman,
      detectedFactsRequested: guarded.output.detectedFactsRequested,
      riskFlags: guarded.output.riskFlags,
      suggestedNextAction: guarded.output.suggestedNextAction,
    },
    retried,
    validationFailed: false,
  };
}
