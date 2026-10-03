import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { SetterPromptContext } from "@/domain/providers/types";
import { createSetterLLMProvider } from "./factory";
import { OpenAISetterProvider } from "./openai-setter-provider";

const context: SetterPromptContext = {
  language: "es",
  offer: {
    company: "Vitalcap",
    description: "Approved offer",
    primaryCta: "book_meeting",
    bookingUrl: "https://example.test/book",
    approvedCommercialFacts: {},
    approvedProductFacts: {},
    approvedClaims: [],
    forbiddenClaims: [],
    faq: [],
    objectionGuidance: {},
    toneConfig: {},
  },
  account: { name: "Farmacia Central", businessType: "pharmacy" },
  contact: null,
  discoverySource: null,
  recentMessages: [],
  recentFeedbackNotes: [],
  latestIncomingMessage: "Hola",
  isRepairAttempt: false,
};

describe("OpenAISetterProvider", () => {
  it("requests structured output and reports token usage without bypassing shared validation", async () => {
    const output = { branch: "PRICE", confidence: 0.9 };
    const create = vi.fn().mockResolvedValue({
      output_text: JSON.stringify(output),
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    });
    const provider = new OpenAISetterProvider({ responses: { create } } as unknown as OpenAI, "gpt-test");

    const result = await provider.classifyAndDraft(context);

    expect(result.output).toEqual(output);
    expect(result.usage).toMatchObject({ model: "gpt-test", inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-test",
      text: { format: expect.objectContaining({ type: "json_schema", strict: true }) },
    }));
  });

  it("returns unparseable structured content to the shared repair validator", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "not json", usage: null });
    const provider = new OpenAISetterProvider({ responses: { create } } as unknown as OpenAI, "gpt-test");
    const result = await provider.classifyAndDraft(context);
    expect(result.output).toBeNull();
    expect(result.usage.errors).toBe(1);
  });
});

describe("createSetterLLMProvider", () => {
  const baseConfig = { LLM_PROVIDER_API_KEY: "test-key", LLM_MODEL: "gpt-setter", LLM_PROVIDER: "openai" as const };

  it("uses LLM_MODEL without requiring PROSPECT_LLM_MODEL", () => {
    const provider = createSetterLLMProvider(baseConfig, "development");
    expect(provider).toBeInstanceOf(OpenAISetterProvider);
  });

  it("fails visibly when OpenAI is selected without an API key", () => {
    expect(() => createSetterLLMProvider({ ...baseConfig, LLM_PROVIDER_API_KEY: undefined }, "production"))
      .toThrow("LLM_PROVIDER=openai requires LLM_PROVIDER_API_KEY.");
  });

  it("does not allow the mock provider in production", () => {
    expect(() => createSetterLLMProvider({ ...baseConfig, LLM_PROVIDER: "mock" }, "production"))
      .toThrow("LLM_PROVIDER=mock is forbidden in production.");
  });

  it("uses the disabled provider instead of falling back to mock", () => {
    const provider = createSetterLLMProvider({ ...baseConfig, LLM_PROVIDER: "disabled" }, "production");
    expect(provider.providerName).toBe("disabled-llm");
  });
});