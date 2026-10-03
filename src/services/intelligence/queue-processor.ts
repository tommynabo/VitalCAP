import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, sql } from "drizzle-orm";
import { ProspectContextBuilder } from "./prospect-context-builder";
import { OpenAIProspectAnalyzer } from "./openai-prospect-analyzer";
import { deferExhaustedBudget, deferUnavailableProvider, retryFailedJob } from "./queue-policy";
import { getDayBounds } from "@/lib/time/day-bounds";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;

export interface IntelligenceBatchResult {
  claimed: number;
  completed: number;
  deferred: number;
  failed: number;
}

export class IntelligenceQueueProcessor {
  async processBatch(): Promise<IntelligenceBatchResult> {
    const db = getDb();
    const now = new Date();
    const lockExpiry = new Date(now.getTime() - LOCK_TIMEOUT_MINUTES * 60000);
    const lockedById = `cron-${now.getTime()}`;

    // 1. Lease jobs using CTE
    const leased = await db.execute(sql`
      WITH available AS (
        SELECT id FROM intelligence_jobs
        WHERE (locked_at IS NULL OR locked_at < ${lockExpiry.toISOString()})
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
          AND status IN ('pending', 'failed', 'processing', 'budget_paused', 'provider_disabled') -- processing means lock expired
          AND attempt_count < max_attempts
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE intelligence_jobs
      SET locked_at = ${now.toISOString()},
          locked_by = ${lockedById},
          attempt_count = attempt_count + 1,
          status = 'processing'
      FROM available
      WHERE intelligence_jobs.id = available.id
      RETURNING intelligence_jobs.*
    `);

    if (leased.rows.length === 0) return { claimed: 0, completed: 0, deferred: 0, failed: 0 };

    const { getIntelligenceEnv } = await import("@/lib/config/env");
    const env = getIntelligenceEnv();
    if (env.LLM_PROVIDER !== "openai" || !env.LLM_PROVIDER_API_KEY || !env.PROSPECT_LLM_MODEL) {
      for (const job of leased.rows as any[]) {
        const deferred = deferUnavailableProvider(job.attempt_count, now);
        await db.update(schema.intelligenceJobs)
          .set({
            lockedAt: null,
            lockedBy: null,
            status: deferred.status,
            attemptCount: deferred.attemptCount,
            lastError: env.LLM_PROVIDER !== "openai" ? "Prospect Intelligence OpenAI provider is unavailable" : "Missing LLM API key or PROSPECT_LLM_MODEL",
            nextAttemptAt: deferred.nextAttemptAt,
          })
          .where(eq(schema.intelligenceJobs.id, job.id));
      }
      return { claimed: leased.rows.length, completed: 0, deferred: leased.rows.length, failed: 0 };
    }

    const contextBuilder = new ProspectContextBuilder();
    const analyzer = new OpenAIProspectAnalyzer();

    let processedCount = 0;
    let deferredCount = 0;
    let failedCount = 0;

    for (const job of leased.rows as any[]) {
      try {
        const context = await contextBuilder.buildContext(job.campaign_id, job.account_id);
        if (!context) {
          throw new Error("Failed to build prospect context (missing data).");
        }

        // Hard Deterministic Gates
        const membershipRows = await db.select().from(schema.campaignMemberships)
          .where(sql`campaign_id = ${job.campaign_id} AND account_id = ${job.account_id}`)
          .limit(1);
        const membership = membershipRows[0];
        
        const accountRows = await db.select().from(schema.accounts).where(sql`id = ${job.account_id}`).limit(1);
        const account = accountRows[0];

        const campaignRows = await db.select().from(schema.campaigns).where(sql`id = ${job.campaign_id}`).limit(1);
        const campaign = campaignRows[0];
        
        if (!membership || !membership.qualifiedAt) {
          throw new Error(`Hard Gate: Membership has no qualifiedAt timestamp`);
        }
        if (!account || account.status === 'rejected_country' || account.status === 'no_contact_found') {
          throw new Error(`Hard Gate: Account status is ${account?.status}`);
        }
        if (!campaign || campaign.status !== 'active') {
          throw new Error(`Hard Gate: Campaign is not active`);
        }
        
        // Suppression check (Global suppression repo to be added per Objective 31)
        const { checkSuppression } = await import("@/services/compliance/suppression");
        const isSuppressed = await checkSuppression(account.workspaceId, { accountId: account.id });
        if (isSuppressed) {
          throw new Error("Hard Gate: Account is globally suppressed");
        }

        const analysis = await analyzer.analyze(context) as any;
        if (!analysis) throw new Error("No analysis returned.");
        
        if (analysis.status === "budget_paused") {
          const settings = await import("@/infrastructure/neon/repositories/autopilot");
          const autopilotSettings = await settings.getAutopilotSettings(job.workspace_id);
          const nextBudgetWindow = getDayBounds(autopilotSettings.timezone, now).end;
          const deferred = deferExhaustedBudget(job.attempt_count, nextBudgetWindow);
          await db.update(schema.intelligenceJobs)
            .set({
              lockedAt: null,
              lockedBy: null,
              status: deferred.status,
              attemptCount: deferred.attemptCount,
              lastError: String(analysis.error || "Intelligence budget exhausted"),
              nextAttemptAt: deferred.nextAttemptAt,
            })
            .where(eq(schema.intelligenceJobs.id, job.id));
          deferredCount += 1;
          continue;
        }

        if (analysis.status !== "completed" && analysis.status !== "failed") {
          const deferred = deferUnavailableProvider(job.attempt_count, now);
          await db.update(schema.intelligenceJobs)
            .set({
              lockedAt: null,
              lockedBy: null,
              status: deferred.status,
              attemptCount: deferred.attemptCount,
              lastError: `Analysis is ${String(analysis.status || "not ready")}`,
              nextAttemptAt: deferred.nextAttemptAt,
            })
            .where(eq(schema.intelligenceJobs.id, job.id));
          deferredCount += 1;
          continue;
        }

        if (analysis.status === "failed") {
          throw new Error(String(analysis.error || "Analysis failed"));
        }

        // Update Account
        await db.update(schema.accounts)
          .set({
            fitScore: analysis.fitScore ?? null,
            fitTier: analysis.fitTier || "unscored",
          })
          .where(eq(schema.accounts.id, job.account_id));

        // Mark job as completed, DO NOT DELETE
        await db.update(schema.intelligenceJobs)
          .set({
            status: "completed",
            lockedAt: null,
            lockedBy: null,
            completedAt: new Date(),
          })
          .where(eq(schema.intelligenceJobs.id, job.id));
        
        processedCount++;

      } catch (error: any) {
        const retry = retryFailedJob(job.attempt_count, job.max_attempts, now);

        await db.update(schema.intelligenceJobs)
          .set({
            lockedAt: null,
            lockedBy: null,
            lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown intelligence job error",
            nextAttemptAt: retry.nextAttemptAt,
            status: retry.status,
          })
          .where(eq(schema.intelligenceJobs.id, job.id));
        failedCount += 1;
      }
    }

    return { claimed: leased.rows.length, completed: processedCount, deferred: deferredCount, failed: failedCount };
  }
}
