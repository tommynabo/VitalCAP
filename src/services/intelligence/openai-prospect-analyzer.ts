import OpenAI from "openai";
import { getServerEnv } from "@/lib/config/env";
import { ProspectContext } from "./types";
import { createHash } from "node:crypto";
import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, and } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const CURRENT_PROMPT_VERSION = "v1.0.0";

const OutputSchema = z.object({
  fitScore: z.number().int().min(0).max(100),
  fitTier: z.enum(["A", "B", "C", "D"]),
  confidence: z.number().min(0).max(100),
  qualified: z.boolean(),
  needsHumanReview: z.boolean(),
  reasoning: z.string(),
});

export class OpenAIProspectAnalyzer {
  private client: OpenAI | null = null;
  private model: string;
  private provider: string;

  constructor() {
    const env = getServerEnv();
    this.provider = env.LLM_PROVIDER;
    this.model = env.PROSPECT_LLM_MODEL || "gpt-4o-2024-08-06";
    
    if (this.provider === "openai" && env.LLM_PROVIDER_API_KEY) {
      this.client = new OpenAI({ apiKey: env.LLM_PROVIDER_API_KEY });
    }
  }

  private hashContext(context: ProspectContext): string {
    return createHash("sha256").update(JSON.stringify(context)).digest("hex");
  }

  private buildSystemPrompt(context: ProspectContext): string {
    return `You are an expert sales intelligence analyst.
Your job is to analyze the prospect context and determine their fit for our offer.
    
Offer Name: ${context.offer.name}
Company: ${context.offer.company}
Offer Description: ${context.offer.description}

You must respond with a JSON object that strictly adheres to the requested schema.`;
  }

  private buildUserPrompt(context: ProspectContext): string {
    return `Analyze this prospect based on the following evidence:
${JSON.stringify(context, null, 2)}`;
  }

  async analyze(context: ProspectContext) {
    if (!this.client || this.provider !== "openai") {
      throw new Error("OpenAI client not configured or disabled.");
    }

    const inputHash = this.hashContext(context);
    const db = getDb();

    // Idempotency Check
    const existing = await db
      .select()
      .from(schema.prospectAnalyses)
      .where(
        and(
          eq(schema.prospectAnalyses.campaignId, context.campaignId),
          eq(schema.prospectAnalyses.accountId, context.accountId),
          eq(schema.prospectAnalyses.promptVersion, CURRENT_PROMPT_VERSION),
          eq(schema.prospectAnalyses.inputHash, inputHash)
        )
      )
      .limit(1);

    if (existing[0] && existing[0].status === "completed") {
      return existing[0]; // Already analyzed successfully
    }

    // Prepare to save analysis row
    const [inserted] = await db.insert(schema.prospectAnalyses).values({
      workspaceId: context.workspaceId,
      campaignId: context.campaignId,
      accountId: context.accountId,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputHash: inputHash,
      provider: "openai",
      model: this.model,
      status: "pending",
    }).returning();
    
    if (!inserted) throw new Error("Failed to insert analysis job");

    try {
      const response = await (this.client as any).beta.chat.completions.parse({
        model: this.model,
        messages: [
          { role: "system", content: this.buildSystemPrompt(context) },
          { role: "user", content: this.buildUserPrompt(context) }
        ],
        response_format: zodResponseFormat(OutputSchema, "prospect_analysis"),
      });

      const parsed = response.choices[0]?.message.parsed;
      const usage = response.usage;

      if (!parsed) {
        throw new Error("No parsed output from OpenAI.");
      }

      // Calculate estimated cost for gpt-4o-2024-08-06
      let estimatedCostUsd = 0;
      if (usage) {
        estimatedCostUsd = (usage.prompt_tokens / 1000000) * 2.50 + (usage.completion_tokens / 1000000) * 10.00;
      }

      const [updated] = await db.update(schema.prospectAnalyses)
        .set({
          status: "completed",
          fitScore: parsed.fitScore,
          fitTier: parsed.fitTier,
          confidence: parsed.confidence.toString(), // numeric column
          qualified: parsed.qualified,
          needsHumanReview: parsed.needsHumanReview,
          analysisJson: parsed,
          inputTokens: usage?.prompt_tokens ?? null,
          outputTokens: usage?.completion_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null,
          estimatedCostUsd: estimatedCostUsd,
          providerRequestId: response.id,
          completedAt: new Date(),
        })
        .where(eq(schema.prospectAnalyses.id, inserted.id))
        .returning();

      if (!updated) throw new Error("Failed to return updated row");
      return updated;
    } catch (error: any) {
      await db.update(schema.prospectAnalyses)
        .set({
          status: "failed",
          error: error.message,
          completedAt: new Date(),
        })
        .where(eq(schema.prospectAnalyses.id, inserted.id));
        
      throw error;
    }
  }
}
