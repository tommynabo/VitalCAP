import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getCoreEnv, getIntelligenceEnv } from "@/lib/config/env";
import type { LLMProvider, SetterPromptContext } from "@/domain/providers/types";
import { MockLLMProvider } from "./mock-provider";
import { OpenAISetterProvider } from "./openai-setter-provider";
import { AnthropicSetterProvider } from "./anthropic-setter-provider";

export interface SetterLLMConfig {
  LLM_PROVIDER: "openai" | "anthropic" | "disabled" | "mock";
  LLM_PROVIDER_API_KEY?: string;
  LLM_MODEL: string;
  CLAUDE_API_KEY?: string;
  CLAUDE_WORKSPACE_ID?: string;
  CLAUDE_MODEL?: string;
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
  if (config.LLM_PROVIDER === "anthropic") {
    if (!config.CLAUDE_API_KEY || !config.CLAUDE_WORKSPACE_ID) {
      throw new Error("LLM_PROVIDER=anthropic requires CLAUDE_API_KEY and CLAUDE_WORKSPACE_ID.");
    }
    const client = new Anthropic({
      apiKey: config.CLAUDE_API_KEY,
      maxRetries: 0,
      timeout: 20_000,
      defaultHeaders: { "anthropic-workspace-id": config.CLAUDE_WORKSPACE_ID },
    });
    return new AnthropicSetterProvider(client, config.CLAUDE_MODEL ?? "claude-sonnet-5-5");
  }
  if (!config.LLM_PROVIDER_API_KEY) throw new Error("LLM_PROVIDER=openai requires LLM_PROVIDER_API_KEY.");
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