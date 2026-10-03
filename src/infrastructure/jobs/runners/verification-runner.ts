import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createEmailVerificationProvider } from "@/infrastructure/providers/provider-factory";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
import { DbVerificationCacheStore } from "@/services/verification/db-verification-cache";
import { verifyEmailsWithCache } from "@/services/verification/email-verification-cache";
import { getVerificationEnv } from "@/lib/config/env";
import { enqueueVerificationJob } from "@/infrastructure/neon/repositories/verification-queue";
import { EMAIL_VERIFICATION_PIPELINE_VERSION } from "@/domain/providers/email-verification-idempotency";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;

export interface VerificationRunnerResult {
  jobsClaimed: number;
  emailsVerified: number;
}

type LeasedVerificationJob = {
  id: string;
  workspace_id: string;
  contact_point_id: string;
  attempt_count: number;
  max_attempts: number;
};

async function deferVerificationJobs(
  jobs: readonly LeasedVerificationJob[],
  error: string,
  now: Date,
  retryAt?: Date,
): Promise<void> {
  const db = getDb();
  for (const job of jobs) {
    const isDeadLetter = job.attempt_count >= job.max_attempts;
    await db.update(schema.verificationJobs)
      .set({
        status: retryAt ? "pending" : isDeadLetter ? "dead_letter" : "failed",
        lastError: error.slice(0, 1000),
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: retryAt ?? (isDeadLetter ? null : new Date(now.getTime() + Math.min(60, 2 ** job.attempt_count) * 60_000)),
      })
      .where(eq(schema.verificationJobs.id, job.id));
  }
}

export async function enqueueVerificationJobs(): Promise<number> {
  const db = getDb();
  
  // Requeue unverified contacts and unknown results after their short cache window expires.
  // Limit to 500 per tick to avoid blowing up the query
  const query = sql`
    WITH eligible_accounts AS (
      SELECT DISTINCT cm.account_id, cm.workspace_id
      FROM campaign_memberships cm
      JOIN campaigns c ON cm.campaign_id = c.id
      WHERE cm.stage IN ('qualified', 'ready')
        AND c.status = 'active'
    )
    SELECT cp.id as contact_point_id, ea.workspace_id, cp.normalized_value
    FROM contact_points cp
    JOIN eligible_accounts ea ON cp.account_id = ea.account_id
    WHERE cp.type = 'email'
      AND (
        cp.verification_status = 'unverified'
        OR (cp.verification_status = 'unknown' AND (cp.verification_checked_at IS NULL OR cp.verification_checked_at <= NOW() - INTERVAL '3 days'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM verification_jobs vj
        WHERE vj.contact_point_id = cp.id
          AND vj.status IN ('pending', 'processing')
      )
    LIMIT 500
  `;

  const rows = await db.execute(query);
  const providerName = getVerificationEnv().EMAIL_VERIFICATION_PROVIDER;

  let count = 0;
  for (const row of rows.rows as any[]) {
    const created = await enqueueVerificationJob({
      workspaceId: row.workspace_id,
      contactPointId: row.contact_point_id,
      normalizedEmail: row.normalized_value,
      provider: providerName,
    });
    if (created) count++;
  }

  return count;
}

export async function runVerificationCronTick(maxJobs: number = BATCH_SIZE): Promise<VerificationRunnerResult> {
  const db = getDb();
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - LOCK_TIMEOUT_MINUTES * 60000);
  const lockedById = `cron-verification-${randomUUID()}`;

  const env = getVerificationEnv();
  const providerName = env.EMAIL_VERIFICATION_PROVIDER;

  // 1. Lease jobs
  const leased = await db.execute(sql`
    WITH available AS (
      SELECT id FROM verification_jobs
      WHERE (locked_at IS NULL OR locked_at < ${lockExpiry.toISOString()})
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
        AND status IN ('pending', 'failed', 'processing')
        AND attempt_count < max_attempts
        AND provider = ${providerName}
      ORDER BY created_at ASC
      LIMIT ${maxJobs}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE verification_jobs
    SET locked_at = ${now.toISOString()},
        locked_by = ${lockedById},
        attempt_count = attempt_count + 1,
        status = 'processing'
    FROM available
    WHERE verification_jobs.id = available.id
    RETURNING verification_jobs.*
  `);

  if (leased.rows.length === 0) return { jobsClaimed: 0, emailsVerified: 0 };

  // 2. Handle provider disabled
  if (providerName === "disabled") {
    for (const job of leased.rows as any[]) {
      await db.update(schema.verificationJobs)
        .set({
          lockedAt: null,
          lockedBy: null,
          status: "provider_disabled",
          lastError: "Email verification provider is disabled.",
          nextAttemptAt: null,
        })
        .where(eq(schema.verificationJobs.id, job.id));
    }
    return { jobsClaimed: leased.rows.length, emailsVerified: 0 };
  }

  // 3. Group by workspace (since provider and cache are per workspace)
  const jobsByWorkspace = new Map<string, any[]>();
  for (const job of leased.rows as { id: string, workspace_id: string, contact_point_id: string, attempt_count: number, max_attempts: number }[]) {
    if (!jobsByWorkspace.has(job.workspace_id)) {
      jobsByWorkspace.set(job.workspace_id, []);
    }
    jobsByWorkspace.get(job.workspace_id)!.push(job);
  }

  let totalEmailsVerified = 0;

  for (const [workspaceId, workspaceJobs] of jobsByWorkspace.entries()) {
    let provider;
    try {
      provider = createEmailVerificationProvider(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deferVerificationJobs(workspaceJobs, message, now);
      throw error;
    }

    const cacheStore = new DbVerificationCacheStore(workspaceId, provider.providerName);
    
    // Map jobs to contact points
    const contactPointIds = workspaceJobs.map(j => j.contact_point_id);
    const cpRows = await db.select({
      id: schema.contactPoints.id,
      accountId: schema.contactPoints.accountId,
      normalizedValue: schema.contactPoints.normalizedValue,
    })
    .from(schema.contactPoints)
    .where(sql`${schema.contactPoints.id} IN ${contactPointIds}`);

    const cpMap = new Map(cpRows.map(cp => [cp.id, cp]));
    const emailsToVerify = cpRows.map(cp => cp.normalizedValue);

    let result: Awaited<ReturnType<typeof verifyEmailsWithCache>>;
    try {
      result = await verifyEmailsWithCache(provider, emailsToVerify, cacheStore, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderBudgetExceededError) {
        await deferVerificationJobs(workspaceJobs, message, now, error.retryAt);
        continue;
      }
      await deferVerificationJobs(workspaceJobs, message, now);
      continue;
    }
    
    // Process results
    for (const job of workspaceJobs) {
      const cp = cpMap.get(job.contact_point_id);
      if (!cp) {
        await deferVerificationJobs([job], "Contact point not found", now);
        continue;
      }

      const outcome = result.outcomes.find(o => o.email === cp.normalizedValue);
      if (!outcome) {
        await deferVerificationJobs([job], "No outcome from provider", now);
        continue;
      }

      if (outcome.retryable) {
        await deferVerificationJobs([job], outcome.providerRawCode || "Provider verification failed", now);
        continue;
      }

      // Update contact point
      await db.update(schema.contactPoints)
        .set({
          verificationStatus: outcome.code,
          verificationProvider: provider.providerName,
          verificationCheckedAt: new Date(outcome.checkedAt),
          status: outcome.code === "valid" || outcome.code === "catch_all" || outcome.code === "risky" || outcome.code === "invalid" ? outcome.code : "discovered",
          updatedAt: new Date(),
        })
        .where(eq(schema.contactPoints.id, cp.id));

      await db.insert(schema.emailVerificationEvents).values({
        workspaceId,
        contactPointId: cp.id,
        normalizedEmail: cp.normalizedValue,
        provider: provider.providerName,
        pipelineVersion: EMAIL_VERIFICATION_PIPELINE_VERSION,
        status: outcome.code,
        providerRawCode: outcome.providerRawCode,
        checkedAt: new Date(outcome.checkedAt),
        costUsd: outcome.costUsd,
        metadata: { attemptCount: job.attempt_count },
      });

      // Mark job completed
      await db.update(schema.verificationJobs)
        .set({ status: "completed", completedAt: new Date(), costUsd: outcome.costUsd, lockedAt: null, lockedBy: null, nextAttemptAt: null, lastError: null })
        .where(eq(schema.verificationJobs.id, job.id));

      totalEmailsVerified++;

      // Adjust TTL based on verdict
      let ttlDays = 30;
      if (outcome.code === "catch_all" || outcome.code === "risky") ttlDays = 7;
      else if (outcome.code === "invalid" || outcome.code === "disposable") ttlDays = 90;
      else if (outcome.code === "unknown") ttlDays = 3;
      
      const adjustedExpires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
      await db.update(schema.emailVerifications)
        .set({ expiresAt: adjustedExpires })
        .where(sql`workspace_id = ${workspaceId} AND normalized_email = ${outcome.email} AND provider = ${provider.providerName}`);
      
      const { evaluateComplianceForAccount } = await import("@/services/compliance/compliance-evaluator");
      await evaluateComplianceForAccount(workspaceId, cp.accountId);
    }
  }

  return { jobsClaimed: leased.rows.length, emailsVerified: totalEmailsVerified };
}
