import OpenAI from "openai";
import { getCoreEnv, getIntelligenceEnv } from "@/lib/config/env";
import type { LLMProvider, SetterPromptContext } from "@/domain/providers/types";
import { MockLLMProvider } from "./mock-provider";
import { OpenAISetterProvider } from "./openai-setter-provider";

export interface SetterLLMConfig {
  LLM_PROVIDER: "openai" | "disabled" | "mock";
  LLM_PROVIDER_API_KEY?: string;
  LLM_MODEL: string;
}

export function createSetterLLMProvider(
  config: SetterLLMConfig = getIntelligenceEnv(),
  appEnv: string = getCoreEnv().APP_ENV,
): LLMProvider {
  if (config.LLM_PROVIDER === "disabled") return new DisabledSetterProvider();
  if (config.LLM_PROVIDER === "mock") {
    if (appEnv === "production") throw new Error("LLM_PROVIDER=mock is forbidden in production.");
    return new MockLLMProvider();
  }
  if (!config.LLM_PROVIDER_API_KEY) {
    throw new Error("LLM_PROVIDER=openai requires LLM_PROVIDER_API_KEY.");
  }
  return new OpenAISetterProvider(new OpenAI({ apiKey: config.LLM_PROVIDER_API_KEY, maxRetries: 0, timeout: 20_000 }), config.LLM_MODEL);
}

class DisabledSetterProvider implements LLMProvider {
  readonly providerName = "disabled-llm";

  async classifyAndDraft(context: SetterPromptContext): ReturnType<LLMProvider["classifyAndDraft"]> {
    return {
      output: {
        language: context.language,
        branch: "HUMAN_REQUIRED",
        intentSummary: "Setter LLM is disabled.",
        confidence: 0,
        draft: "Revisión manual requerida.",
        needsHuman: true,
        reasonForHuman: "LLM_PROVIDER is disabled.",
        detectedFactsRequested: [],
        riskFlags: ["llm_disabled"],
        suggestedNextAction: "manual_human_draft",
      },
      usage: { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null },
    };
  }
}