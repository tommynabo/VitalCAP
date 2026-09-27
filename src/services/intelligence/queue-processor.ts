import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, isNull, lt, and, inArray, sql } from "drizzle-orm";
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
          AND attempt_count < max_attempts
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE intelligence_jobs
      SET locked_at = ${now.toISOString()},
          locked_by = ${lockedById},
          attempt_count = attempt_count + 1
      FROM available
      WHERE intelligence_jobs.id = available.id
      RETURNING intelligence_jobs.*
    `);

    if (leased.rows.length === 0) return 0;

    const contextBuilder = new ProspectContextBuilder();
    const analyzer = new OpenAIProspectAnalyzer();

    let processedCount = 0;

    for (const job of leased.rows as any[]) {
      try {
        const context = await contextBuilder.buildContext(job.campaign_id, job.account_id);
        if (!context) {
          throw new Error("Failed to build prospect context (missing data).");
        }

        const analysis = await analyzer.analyze(context);
        if (!analysis) throw new Error("No analysis returned.");

        // Update Account
        await db.update(schema.accounts)
          .set({
            fitScore: analysis.fitScore ?? null,
            fitTier: analysis.fitTier || "unscored",
          })
          .where(eq(schema.accounts.id, job.account_id));

        // Delete job on success
        await db.delete(schema.intelligenceJobs).where(eq(schema.intelligenceJobs.id, job.id));
        processedCount++;

      } catch (error: any) {
        // Unlock and increment next attempt (exponential backoff)
        const nextAttempt = new Date(now.getTime() + Math.pow(2, job.attempt_count) * 60000);
        
        await db.update(schema.intelligenceJobs)
          .set({
            lockedAt: null,
            lockedBy: null,
            lastError: error.message,
            nextAttemptAt: nextAttempt,
          })
          .where(eq(schema.intelligenceJobs.id, job.id));
      }
    }

    return processedCount;
  }
}
