import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, sql } from "drizzle-orm";
import { ProspectContextBuilder } from "./prospect-context-builder";
import { OpenAIProspectAnalyzer } from "./openai-prospect-analyzer";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;

export class IntelligenceQueueProcessor {
  async processBatch(): Promise<number> {
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
          AND status IN ('pending', 'failed', 'processing') -- processing means lock expired
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

    if (leased.rows.length === 0) return 0;

    const { getIntelligenceEnv } = await import("@/lib/config/env");
    const env = getIntelligenceEnv();
    if (env.LLM_PROVIDER === "disabled" || (env.LLM_PROVIDER === "openai" && (!env.LLM_PROVIDER_API_KEY || !env.PROSPECT_LLM_MODEL))) {
      // Mark all leased jobs as provider_disabled
      for (const job of leased.rows as any[]) {
        await db.update(schema.intelligenceJobs)
          .set({
            lockedAt: null,
            lockedBy: null,
            status: "provider_disabled",
            lastError: env.LLM_PROVIDER === "disabled" ? "Provider intentionally disabled" : "Missing LLM API key or explicitly configured model",
            nextAttemptAt: null,
          })
          .where(eq(schema.intelligenceJobs.id, job.id));
      }
      return 0;
    }

    const contextBuilder = new ProspectContextBuilder();
    const analyzer = new OpenAIProspectAnalyzer();

    let processedCount = 0;

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
          // Pause queue job
          await db.update(schema.intelligenceJobs)
            .set({
              lockedAt: null,
              lockedBy: null,
              status: "budget_paused",
              lastError: "Budget exhausted",
            })
            .where(eq(schema.intelligenceJobs.id, job.id));
          continue; // Move to next but this might happen for all
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
        // Handle failure
        const isDeadLetter = job.attempt_count >= job.max_attempts;
        const nextAttempt = isDeadLetter ? null : new Date(now.getTime() + Math.pow(2, job.attempt_count) * 60000);
        const newStatus = isDeadLetter ? "dead_letter" : "failed";

        await db.update(schema.intelligenceJobs)
          .set({
            lockedAt: null,
            lockedBy: null,
            lastError: error.message,
            nextAttemptAt: nextAttempt,
            status: newStatus,
          })
          .where(eq(schema.intelligenceJobs.id, job.id));
      }
    }

    return processedCount;
  }
}
