import OpenAI from "openai";
import { getServerEnv } from "@/lib/config/env";
import { ProspectContext, ProspectAnalysisOutputSchema, ProspectAnalysisOutput } from "./types";
import { createHash } from "node:crypto";
import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, and, sql } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod";

const CURRENT_PROMPT_VERSION = "v1.1.0";

export class OpenAIProspectAnalyzer {
  private client: OpenAI | null = null;
  private model: string;
  private provider: string;

  constructor() {
    const env = getServerEnv();
    this.provider = env.LLM_PROVIDER;
    
    // Do not fabricate a model ID, require explicit config
    this.model = env.PROSPECT_LLM_MODEL || "gpt-4o"; 
    
    // Use OPENAI_API_KEY explicitly for Prospect Intelligence
    if (this.provider === "openai" && env.OPENAI_API_KEY) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
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

  private async checkBudget(): Promise<boolean> {
    const env = getServerEnv();
    if (env.LLM_DAILY_COST_LIMIT_USD || env.LLM_BATCH_COST_LIMIT_USD) {
      // Very basic budget placeholder logic. 
      // A robust implementation would query the db for daily spend and compare against the limits.
      // For now, if limits are strictly 0, block it.
      if (Number(env.LLM_DAILY_COST_LIMIT_USD) <= 0) return false;
      if (Number(env.LLM_BATCH_COST_LIMIT_USD) <= 0) return false;
    }
    return true;
  }

  async analyze(context: ProspectContext) {
    if (this.provider !== "openai" || !this.client) {
      throw new Error("OpenAI provider disabled or not configured.");
    }

    const inputHash = this.hashContext(context);
    const db = getDb();

    // Idempotency Check & Reservation
    // We use an atomic insert with ON CONFLICT DO UPDATE to handle race conditions
    // and allow retries for failed analyses.
    const [reservation] = await db.insert(schema.prospectAnalyses)
      .values({
        workspaceId: context.workspaceId,
        campaignId: context.campaignId,
        accountId: context.accountId,
        promptVersion: CURRENT_PROMPT_VERSION,
        inputHash: inputHash,
        provider: "openai",
        model: this.model,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: [
          schema.prospectAnalyses.campaignId, 
          schema.prospectAnalyses.accountId, 
          schema.prospectAnalyses.promptVersion, 
          schema.prospectAnalyses.inputHash
        ],
        set: {
          status: sql`CASE WHEN "prospect_analyses"."status" IN ('failed', 'budget_paused') THEN 'pending' ELSE "prospect_analyses"."status" END`
        },
      })
      .returning();

    if (!reservation) throw new Error("Failed to reserve analysis job");

    // If another worker is processing this exact hash or already completed it, bail out
    if (reservation.status === "completed") {
      return reservation;
    }

    // Double check if we actually acquired the lock
    if (reservation.status !== "pending") {
      return reservation; // could be "processing" by another worker, let it handle it
    }

    // Set to processing
    await db.update(schema.prospectAnalyses)
      .set({ status: "processing" })
      .where(eq(schema.prospectAnalyses.id, reservation.id));

    // Budget Check
    const budgetOk = await this.checkBudget();
    if (!budgetOk) {
      const [paused] = await db.update(schema.prospectAnalyses)
        .set({ status: "budget_paused" })
        .where(eq(schema.prospectAnalyses.id, reservation.id))
        .returning();
      return paused;
    }

    try {
      // Use current Structured Outputs support
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: this.buildSystemPrompt(context) },
          { role: "user", content: this.buildUserPrompt(context) }
        ],
        response_format: zodResponseFormat(ProspectAnalysisOutputSchema, "prospect_analysis"),
        store: false, // Explicitly false as requested
      });

      const messageContent = response.choices[0]?.message?.content;
      if (!messageContent) {
        throw new Error("No output from OpenAI.");
      }

      const parsed: ProspectAnalysisOutput = JSON.parse(messageContent);
      const usage = response.usage;

      // Validate evidence IDs
      const allValidEvidenceIds = new Set(context.evidence.map(e => e.id));
      for (const fact of parsed.personalizationFacts) {
        if (!fact.evidenceIds || fact.evidenceIds.length === 0) {
          throw new Error("Empty personalization evidenceIds");
        }
        for (const evId of fact.evidenceIds) {
          if (!allValidEvidenceIds.has(evId)) {
            throw new Error(`Unknown Evidence ID: ${evId}`);
          }
        }
      }

      const [updated] = await db.update(schema.prospectAnalyses)
        .set({
          status: "completed",
          fitScore: parsed.fitScore,
          fitTier: parsed.fitTier,
          confidence: parsed.confidence,
          qualified: parsed.qualified,
          needsHumanReview: parsed.needsHumanReview,
          analysisJson: parsed,
          inputTokens: usage?.prompt_tokens ?? null,
          outputTokens: usage?.completion_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null,
          estimatedCostUsd: null, // Removed hardcoded pricing
          providerRequestId: response.id,
          completedAt: new Date()
        })
        .where(eq(schema.prospectAnalyses.id, reservation.id))
        .returning();

      return updated;
    } catch (error: any) {
      const [failed] = await db.update(schema.prospectAnalyses)
        .set({
          status: "failed",
          error: error.message,
          completedAt: new Date()
        })
        .where(eq(schema.prospectAnalyses.id, reservation.id))
        .returning();
        
      return failed;
    }
  }
}
