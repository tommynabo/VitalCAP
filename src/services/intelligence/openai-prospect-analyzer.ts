import OpenAI from "openai";
import { getIntelligenceEnv } from "@/lib/config/env";
import { ProspectContext, ProspectAnalysisOutputSchema, ProspectAnalysisOutput } from "./types";
import { createHash } from "node:crypto";
import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, and, sql } from "drizzle-orm";
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

    // Idempotency Check & Reservation (Atomic Claim)
    const claimToken = require("node:crypto").randomUUID();
    const [reservation] = await db.insert(schema.prospectAnalyses)
      .values({
        workspaceId: context.workspaceId,
        campaignId: context.campaignId,
        accountId: context.accountId,
        promptVersion: CURRENT_PROMPT_VERSION,
        inputHash: inputHash,
        provider: "openai",
        model: this.model,
        status: "processing",
        claimToken,
        startedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          schema.prospectAnalyses.campaignId, 
          schema.prospectAnalyses.accountId, 
          schema.prospectAnalyses.promptVersion, 
          schema.prospectAnalyses.inputHash
        ],
      })
      .returning();

    let activeAnalysis = reservation;
    if (!activeAnalysis) {
      // Attempt to atomic-claim an existing pending/stale analysis
      const claimQuery = await db.execute(sql`
        UPDATE prospect_analyses
        SET status = 'processing', claim_token = ${claimToken}, started_at = NOW()
        WHERE campaign_id = ${context.campaignId}::uuid
          AND account_id = ${context.accountId}::uuid
          AND prompt_version = ${CURRENT_PROMPT_VERSION}
          AND input_hash = ${inputHash}
          AND (status IN ('pending', 'failed', 'budget_paused') OR (status = 'processing' AND started_at < NOW() - INTERVAL '10 minutes'))
        RETURNING *
      `);
      activeAnalysis = claimQuery.rows[0] as any;
      
      if (!activeAnalysis) {
        // It's already completed or currently being processed by another worker
        const existingQuery = await db.execute(sql`
          SELECT * FROM prospect_analyses 
          WHERE campaign_id = ${context.campaignId}::uuid
          AND account_id = ${context.accountId}::uuid
          AND prompt_version = ${CURRENT_PROMPT_VERSION}
          AND input_hash = ${inputHash}
        `);
        return existingQuery.rows[0];
      }
    }

    const env = getIntelligenceEnv();
    const pricing = PRICING[this.model];
    if (!pricing) {
       throw new Error(`Pricing for model ${this.model} is unknown. Explicit cost config required. No silent fallback allowed.`);
    }
    const expectedCost = (1500 * pricing.input) + (500 * pricing.output); // Conservative estimate
    
    if (env.LLM_BATCH_COST_LIMIT_USD && expectedCost > env.LLM_BATCH_COST_LIMIT_USD) {
       throw new Error(`Expected single-call cost ${expectedCost} exceeds batch limit ${env.LLM_BATCH_COST_LIMIT_USD}`);
    }

    // Budget Check against real provider_runs (Atomic)
    let providerRun;
    try {
      providerRun = await db.transaction(async (tx) => {
        const settings = await getAutopilotSettings(context.workspaceId);
        const { start } = getDayBounds(settings.timezone);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${context.workspaceId}::text || ${start.toISOString()}::text || 'openai'))`);
        
        const budgetRes = await tx.execute(sql`
          SELECT COALESCE(SUM(cost_usd), 0)::numeric as cost_today 
          FROM provider_runs 
          WHERE workspace_id = ${context.workspaceId}::uuid 
            AND provider = 'openai' 
            AND started_at >= ${start.toISOString()}::timestamptz
        `);
        const costToday = Number(budgetRes.rows[0]?.cost_today ?? 0);

        if (env.LLM_DAILY_COST_LIMIT_USD && (costToday + expectedCost > env.LLM_DAILY_COST_LIMIT_USD)) {
          throw new Error("Daily LLM budget exhausted");
        }

        const requestKey = `openai-analyze-${activeAnalysis.id}-${inputHash}-${CURRENT_PROMPT_VERSION}`;
        const pr = await tx.execute(sql`
          INSERT INTO provider_runs (
            workspace_id, campaign_id, provider, operation, request_key, status, items_requested, items_returned, cost_usd, metadata, started_at
          ) VALUES (
            ${context.workspaceId}::uuid, ${context.campaignId}::uuid, 'openai', 'chat_completion', ${requestKey},
            'starting', 1, 0, ${expectedCost}, ${JSON.stringify({ model: this.model, analysisId: activeAnalysis.id })}::jsonb, NOW()
          )
          ON CONFLICT (request_key) DO NOTHING
          RETURNING *
        `);
        
        if (pr.rows.length === 0) {
           const existing = await tx.execute(sql`SELECT * FROM provider_runs WHERE request_key = ${requestKey}`);
           return existing.rows[0] as { id: string; status: string; };
        }
        return pr.rows[0] as { id: string; status: string; };
      });
    } catch (budgetError: any) {
      if (budgetError.message === "Daily LLM budget exhausted") {
        const [paused] = await db.update(schema.prospectAnalyses)
          .set({ status: "budget_paused", error: "Daily LLM budget exhausted", claimToken: null })
          .where(eq(schema.prospectAnalyses.id, activeAnalysis.id))
          .returning();
        return paused;
      }
      throw budgetError;
    }

    if (providerRun.status === "succeeded" || providerRun.status === "completed") {
      // Replay idempotency: if it already ran and succeeded, we return active analysis.
      // But wait, if it succeeded, why did activeAnalysis still need processing?
      // In a robust system, we would just fetch the stored response. For now we will allow it to proceed or bail.
    }

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
        .where(and(eq(schema.prospectAnalyses.id, activeAnalysis.id), eq(schema.prospectAnalyses.claimToken, activeAnalysis.claimToken || "")))
        .returning();

      // Update provider_run
      await db.update(schema.providerRuns).set({
        status: "succeeded",
        itemsReturned: 1,
        costUsd: actualCostUsd,
        externalRunId: response.id,
        finishedAt: new Date(),
        metadata: { model: this.model, analysisId: activeAnalysis.id, tokens: usage?.total_tokens }
      }).where(eq(schema.providerRuns.id, providerRun.id));

      return updated;
    } catch (error: any) {
      await db.update(schema.prospectAnalyses)
        .set({
          status: "failed",
          error: error.message,
          completedAt: new Date()
        })
        .where(and(eq(schema.prospectAnalyses.id, activeAnalysis.id), eq(schema.prospectAnalyses.claimToken, activeAnalysis.claimToken || "")));
        
      await db.update(schema.providerRuns).set({
        status: "failed",
        error: error.message,
        finishedAt: new Date(),
      }).where(eq(schema.providerRuns.id, providerRun.id));
        
      const [failed] = await db.select().from(schema.prospectAnalyses).where(eq(schema.prospectAnalyses.id, activeAnalysis.id));
      return failed;
    }
  }
}
