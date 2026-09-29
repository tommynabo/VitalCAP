import OpenAI from "openai";
import { getIntelligenceEnv } from "@/lib/config/env";
import { ProspectContext, ProspectAnalysisOutputSchema, ProspectAnalysisOutput } from "./types";
import { createHash } from "node:crypto";
import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, sql } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod";
import { getDayBounds } from "@/lib/time/day-bounds";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";

const CURRENT_PROMPT_VERSION = "v1.1.0";

const PRICING: Record<string, { input: number, output: number }> = {
  "gpt-4o-2024-08-06": { input: 2.5 / 1000000, output: 10.0 / 1000000 },
  "gpt-4o-mini-2024-07-18": { input: 0.15 / 1000000, output: 0.6 / 1000000 },
  "gpt-4o": { input: 2.5 / 1000000, output: 10.0 / 1000000 },
  "gpt-4o-mini": { input: 0.15 / 1000000, output: 0.6 / 1000000 },
};
const FALLBACK_PRICING = { input: 5.0 / 1000000, output: 15.0 / 1000000 };

export class OpenAIProspectAnalyzer {
  private client: OpenAI | null = null;
  private model: string;
  private provider: string;

  constructor() {
    const env = getIntelligenceEnv();
    this.provider = env.LLM_PROVIDER;
    
    // Do not fabricate a model ID, require explicit config
    if (this.provider === "openai" && !env.PROSPECT_LLM_MODEL) {
       this.provider = "unavailable";
       this.model = "unknown";
    } else {
       this.model = env.PROSPECT_LLM_MODEL || "unknown"; 
    }
    
    // Use LLM_PROVIDER_API_KEY explicitly for Prospect Intelligence
    if (this.provider === "openai" && env.LLM_PROVIDER_API_KEY) {
      this.client = new OpenAI({ apiKey: env.LLM_PROVIDER_API_KEY });
    } else if (this.provider === "openai") {
      this.provider = "unavailable";
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
    if (this.provider !== "openai" || !this.client) {
      throw new Error("OpenAI provider disabled or not configured.");
    }

    const inputHash = this.hashContext(context);
    const db = getDb();

    // Idempotency Check & Reservation
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
    if (reservation.status !== "pending") {
      return reservation;
    }

    // Set to processing
    await db.update(schema.prospectAnalyses)
      .set({ status: "processing" })
      .where(eq(schema.prospectAnalyses.id, reservation.id));

    // Budget Check against real provider_runs
    const env = getIntelligenceEnv();
    const settings = await getAutopilotSettings(context.workspaceId);
    const { start } = getDayBounds(settings.timezone);
    const expectedCost = 0.015; // conservative estimate for an LLM call

    const budgetQuery = sql`
      SELECT COALESCE(SUM(cost_usd), 0)::numeric as cost_today 
      FROM provider_runs 
      WHERE workspace_id = ${context.workspaceId}::uuid 
        AND provider = 'openai' 
        AND started_at >= ${start.toISOString()}::timestamptz
    `;
    const budgetRes = await db.execute(budgetQuery);
    const costToday = Number(budgetRes.rows[0]?.cost_today ?? 0);

    if (env.LLM_DAILY_COST_LIMIT_USD && (costToday + expectedCost > env.LLM_DAILY_COST_LIMIT_USD)) {
      const [paused] = await db.update(schema.prospectAnalyses)
        .set({ status: "budget_paused", error: "Daily LLM budget exhausted" })
        .where(eq(schema.prospectAnalyses.id, reservation.id))
        .returning();
      return paused;
    }

    // Insert starting provider_run for ledger tracking
    const requestKey = `openai-analyze-${reservation.id}-${Date.now()}`;
    const [providerRun] = await db.insert(schema.providerRuns)
      .values({
        workspaceId: context.workspaceId,
        campaignId: context.campaignId,
        provider: "openai",
        operation: "chat_completion",
        requestKey,
        status: "starting",
        itemsRequested: 1,
        itemsReturned: 0,
        costUsd: expectedCost,
        metadata: { model: this.model, analysisId: reservation.id },
      }).returning();
      
    if (!providerRun) throw new Error("Failed to reserve provider run ledger entry");

    try {
      const response = await this.client.chat.completions.parse({
        model: this.model,
        messages: [
          { role: "system", content: this.buildSystemPrompt(context) },
          { role: "user", content: this.buildUserPrompt(context) }
        ],
        response_format: zodResponseFormat(ProspectAnalysisOutputSchema, "prospect_analysis"),
        store: false,
      });

      const parsed: ProspectAnalysisOutput | null = response.choices[0]?.message?.parsed ?? null;
      if (!parsed) {
        throw new Error("No structured output from OpenAI.");
      }

      const usage = response.usage;
      
      const pricing = PRICING[this.model] ?? FALLBACK_PRICING;
      const actualCostUsd = ((usage?.prompt_tokens ?? 0) * pricing.input) + ((usage?.completion_tokens ?? 0) * pricing.output);

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
          estimatedCostUsd: actualCostUsd,
          providerRequestId: response.id,
          completedAt: new Date()
        })
        .where(eq(schema.prospectAnalyses.id, reservation.id))
        .returning();

      // Update provider_run
      await db.update(schema.providerRuns).set({
        status: "succeeded",
        itemsReturned: 1,
        costUsd: actualCostUsd,
        externalRunId: response.id,
        finishedAt: new Date(),
        metadata: { model: this.model, analysisId: reservation.id, tokens: usage?.total_tokens }
      }).where(eq(schema.providerRuns.id, providerRun.id));

      return updated;
    } catch (error: any) {
      await db.update(schema.prospectAnalyses)
        .set({
          status: "failed",
          error: error.message,
          completedAt: new Date()
        })
        .where(eq(schema.prospectAnalyses.id, reservation.id));
        
      await db.update(schema.providerRuns).set({
        status: "failed",
        error: error.message,
        finishedAt: new Date(),
      }).where(eq(schema.providerRuns.id, providerRun.id));
        
      const [failed] = await db.select().from(schema.prospectAnalyses).where(eq(schema.prospectAnalyses.id, reservation.id));
      return failed;
    }
  }
}
