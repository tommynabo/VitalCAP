import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LLMProvider, SetterClassificationOutput, SetterPromptContext } from "@/domain/providers/types";
import { emptyProviderUsageStats } from "@/domain/providers/types";
import { setterOutputSchema } from "@/services/setter/setter-output-schema";

export class AnthropicSetterProvider implements LLMProvider {
  readonly providerName = "anthropic-setter";

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async classifyAndDraft(context: SetterPromptContext): ReturnType<LLMProvider["classifyAndDraft"]> {
    const startedAt = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1_200,
      system: [
        "Classify the latest inbound sales reply and produce a concise draft in the requested language.",
        "Use only facts present in the supplied offer and account context. Never invent pricing, discounts, availability, medical claims, capabilities, or exclusivity.",
        "If required information is missing, set branch to HUMAN_REQUIRED, needsHuman to true, and explain why.",
        "Every draft is for human review. Do not send messages or call tools.",
        context.isRepairAttempt ? "Repair attempt: return a complete object matching the required schema exactly." : "",
      ].filter(Boolean).join("\n"),
      messages: [{ role: "user", content: JSON.stringify(context) }],
      output_config: { format: zodOutputFormat(setterOutputSchema) },
    });

    const textBlock = response.content.find((block) => block.type === "text");
    let output: unknown = null;
    try {
      output = textBlock ? JSON.parse(textBlock.text) : null;
    } catch {
      // Return invalid content to shared validation so its repair retry remains authoritative.
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
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
      },
    };
  }
}