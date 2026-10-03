import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { LLMProvider, SetterClassificationOutput, SetterPromptContext } from "@/domain/providers/types";
import { emptyProviderUsageStats } from "@/domain/providers/types";
import { setterOutputSchema } from "@/services/setter/setter-output-schema";

export class OpenAISetterProvider implements LLMProvider {
  readonly providerName = "openai-setter";

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async classifyAndDraft(context: SetterPromptContext): ReturnType<LLMProvider["classifyAndDraft"]> {
    const startedAt = Date.now();
    const response = await this.client.responses.create({
      model: this.model,
      max_output_tokens: 1_200,
      instructions: [
        "Classify the latest inbound sales reply and produce a concise draft in the requested language.",
        "Use only facts present in the supplied offer and account context. Never invent pricing, discounts, availability, medical claims, capabilities, or exclusivity.",
        "If required information is missing, set branch to HUMAN_REQUIRED, needsHuman to true, and explain why.",
        "Every draft is for human review. Do not send messages or call tools.",
        context.isRepairAttempt ? "Repair attempt: return a complete object matching the required schema exactly." : "",
      ].filter(Boolean).join("\n"),
      input: JSON.stringify(context),
      text: { format: zodTextFormat(setterOutputSchema, "setter_classification") },
    });

    let output: unknown = null;
    try {
      output = JSON.parse(response.output_text);
    } catch {
      // Return an invalid value to the shared schema validator so its repair retry remains authoritative.
    }

    const usage = response.usage;
    return {
      output: output as SetterClassificationOutput,
      usage: {
        ...emptyProviderUsageStats(),
        calls: 1,
        items: output === null ? 0 : 1,
        errors: output === null ? 1 : 0,
        totalLatencyMs: Date.now() - startedAt,
        model: this.model,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    };
  }
}