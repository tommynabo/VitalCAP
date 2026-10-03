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

function humanRequiredFallback(
  context: SetterPromptContext,
  reason: string,
  riskFlag = "invalid_llm_output",
  providerMetadata: Record<string, unknown> = {},
): DraftFields {
  return {
    language: context.language,
    branch: "HUMAN_REQUIRED" satisfies SetterBranch,
    intentSummary: riskFlag === "invalid_llm_output" ? "LLM output failed structured validation." : "LLM classification is unavailable.",
    confidence: 0,
    draft: "",
    needsHuman: true,
    reasonForHuman: reason,
    detectedFactsRequested: [],
    riskFlags: [riskFlag],
    suggestedNextAction: "manual_human_draft",
    providerMetadata,
  };
}

function failureCode(error: unknown): string {
  const details = error as { name?: string; code?: string; status?: number; message?: string };
  if (details.status === 429 || details.code === "rate_limit_exceeded") return "rate_limit";
  if (details.name === "AbortError" || /timeout/i.test(details.name ?? "") || details.code === "ETIMEDOUT") return "timeout";
  if (/budget/i.test(details.message ?? "")) return "budget_limit";
  if (/configuration|api key/i.test(details.message ?? "")) return "configuration_error";
  return "provider_failure";
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]").slice(0, 500);
}

function providerMetadata(
  provider: LLMProvider,
  results: Array<Awaited<ReturnType<LLMProvider["classifyAndDraft"]>>>,
  errorCode: string | null = null,
): Record<string, unknown> {
  const usage = results.map((result) => result.usage);
  const sum = (key: "calls" | "errors" | "inputTokens" | "outputTokens" | "totalTokens" | "totalLatencyMs") =>
    usage.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  return {
    provider: provider.providerName,
    model: usage.find((entry) => entry.model)?.model ?? null,
    calls: sum("calls"),
    errors: sum("errors") + (errorCode ? 1 : 0),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    totalLatencyMs: sum("totalLatencyMs"),
    costUsd: usage.some((entry) => entry.costUsd > 0) ? usage.reduce((total, entry) => total + entry.costUsd, 0) : null,
    failureCode: errorCode,
  };
}

export async function classifyAndDraft(provider: LLMProvider, context: SetterPromptContext): Promise<ClassifyAndDraftResult> {
  let retried = false;
  const results: Array<Awaited<ReturnType<LLMProvider["classifyAndDraft"]>>> = [];
  let first: Awaited<ReturnType<LLMProvider["classifyAndDraft"]>>;
  try {
    first = await provider.classifyAndDraft(context);
    results.push(first);
  } catch (error) {
    const code = failureCode(error);
    return {
      draft: humanRequiredFallback(
        context,
        `LLM request failed (${code}): ${safeErrorMessage(error)}`,
        code,
        providerMetadata(provider, results, code),
      ),
      retried,
      validationFailed: false,
    };
  }
  let validation = validateSetterOutput(first.output);

  if (!validation.success) {
    retried = true;
    let retry: Awaited<ReturnType<LLMProvider["classifyAndDraft"]>>;
    try {
      retry = await provider.classifyAndDraft({ ...context, isRepairAttempt: true });
      results.push(retry);
    } catch (error) {
      const code = failureCode(error);
      return {
        draft: humanRequiredFallback(
          context,
          `LLM repair failed (${code}): ${safeErrorMessage(error)}`,
          code,
          providerMetadata(provider, results, code),
        ),
        retried,
        validationFailed: false,
      };
    }
    validation = validateSetterOutput(retry.output);
  }

  if (!validation.success || !validation.data) {
    return {
      draft: humanRequiredFallback(
        context,
        `Invalid LLM output after retry: ${validation.errorSummary ?? "unknown error"}`,
        "invalid_llm_output",
        providerMetadata(provider, results, "invalid_llm_output"),
      ),
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
      providerMetadata: providerMetadata(provider, results),
    },
    retried,
    validationFailed: false,
  };
}
