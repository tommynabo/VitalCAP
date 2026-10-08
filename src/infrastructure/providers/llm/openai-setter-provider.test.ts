import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { SetterPromptContext } from "@/domain/providers/types";
import { classifyAndDraft } from "@/services/setter/classify-and-draft";
import { createSetterLLMProvider } from "./factory";
import { AnthropicSetterProvider } from "./anthropic-setter-provider";
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

describe("AnthropicSetterProvider", () => {
  const humanRequiredOutput = {
    language: "es",
    branch: "HUMAN_REQUIRED",
    intentSummary: "Falta información aprobada.",
    confidence: 0.4,
    draft: "Revisaremos la información y te responderemos.",
    needsHuman: true,
    reasonForHuman: "Revisión manual requerida.",
    detectedFactsRequested: [],
    riskFlags: [],
    suggestedNextAction: "manual_human_draft",
  };

  it("requests structured JSON output and maps token usage", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(humanRequiredOutput) }],
      usage: { input_tokens: 15, output_tokens: 9 },
    });
    const provider = new AnthropicSetterProvider({ messages: { create } } as unknown as Anthropic, "claude-test");

    const result = await provider.classifyAndDraft(context);
    const request = create.mock.calls[0]?.[0];

    expect(result.output).toEqual(humanRequiredOutput);
    expect(result.usage).toMatchObject({ model: "claude-test", inputTokens: 15, outputTokens: 9, totalTokens: 24 });
    expect(request?.output_config?.format).toMatchObject({ type: "json_schema", schema: { type: "object" } });
    expect(request?.output_config?.format?.schema?.properties).toMatchObject({ confidence: { type: "number" } });
    expect(request?.system).toContain("Every draft is for human review");
  });

  it("returns malformed structured content to shared validation and repair", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "not json" }], usage: { input_tokens: 3, output_tokens: 2 } });
    const provider = new AnthropicSetterProvider({ messages: { create } } as unknown as Anthropic, "claude-test");
    const result = await provider.classifyAndDraft(context);
    expect(result.output).toBeNull();
    expect(result.usage.errors).toBe(1);
  });

  it("keeps HUMAN_REQUIRED output in the shared human-review path without sending email", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(humanRequiredOutput) }],
      usage: { input_tokens: 15, output_tokens: 9 },
    });
    const provider = new AnthropicSetterProvider({ messages: { create } } as unknown as Anthropic, "claude-test");

    const result = await classifyAndDraft(provider, context);

    expect(result.draft).toMatchObject({ branch: "HUMAN_REQUIRED", needsHuman: true, reasonForHuman: "Revisión manual requerida." });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("createSetterLLMProvider", () => {
  const baseConfig = { LLM_PROVIDER_API_KEY: "test-key", LLM_MODEL: "gpt-setter", LLM_PROVIDER: "openai" as const };

  it("uses LLM_MODEL without requiring PROSPECT_LLM_MODEL", () => {
    const provider = createSetterLLMProvider(baseConfig, "development");
    expect(provider).toBeInstanceOf(OpenAISetterProvider);
  });

  it("configures Anthropic with the Claude workspace and model", () => {
    const provider = createSetterLLMProvider({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "unused",
      CLAUDE_API_KEY: "test-key",
      CLAUDE_WORKSPACE_ID: "workspace-test",
      CLAUDE_MODEL: "claude-sonnet-5-5",
    }, "production");
    expect(provider).toBeInstanceOf(AnthropicSetterProvider);
    const client = (provider as unknown as { client: { _options: { defaultHeaders: Record<string, string> } } }).client;
    expect(client._options.defaultHeaders).toMatchObject({ "anthropic-workspace-id": "workspace-test" });
  });

  it("requires both Anthropic credentials when Anthropic is selected", () => {
    expect(() => createSetterLLMProvider({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "unused",
      CLAUDE_API_KEY: "test-key",
    }, "production")).toThrow("LLM_PROVIDER=anthropic requires CLAUDE_API_KEY and CLAUDE_WORKSPACE_ID.");
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