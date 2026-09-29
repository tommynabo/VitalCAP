import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createEmailVerificationProvider } from "@/infrastructure/providers/provider-factory";
import { DbVerificationCacheStore } from "@/services/verification/db-verification-cache";
import { verifyEmailsWithCache } from "@/services/verification/email-verification-cache";
import { getVerificationEnv } from "@/lib/config/env";
import { enqueueVerificationJob } from "@/infrastructure/neon/repositories/verification-queue";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;

export interface VerificationRunnerResult {
  jobsClaimed: number;
  emailsVerified: number;
}

export async function enqueueVerificationJobs(): Promise<number> {
  const db = getDb();
  
  // Find accounts that are analyzed-qualified, have unverified email contact points, and don't already have a pending verification job
  // Limit to 500 per tick to avoid blowing up the query
  const query = sql`
    WITH eligible_accounts AS (
      SELECT DISTINCT cm.account_id, cm.workspace_id
      FROM campaign_memberships cm
      JOIN campaigns c ON cm.campaign_id = c.id
      WHERE cm.stage IN ('qualified', 'ready')
        AND c.status = 'active'
        AND EXISTS (
          SELECT 1 FROM prospect_analyses pa
          WHERE pa.account_id = cm.account_id
            AND pa.campaign_id = cm.campaign_id
            AND pa.status = 'completed'
            AND pa.qualified = true
            AND pa.id = (
              SELECT id FROM prospect_analyses pa2
              WHERE pa2.account_id = cm.account_id
                AND pa2.campaign_id = cm.campaign_id
              ORDER BY created_at DESC LIMIT 1
            )
        )
    )
    SELECT cp.id as contact_point_id, ea.workspace_id
    FROM contact_points cp
    JOIN eligible_accounts ea ON cp.account_id = ea.account_id
    WHERE cp.type = 'email'
      AND cp.verification_status = 'unverified'
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
    await enqueueVerificationJob({
      workspaceId: row.workspace_id,
      contactPointId: row.contact_point_id,
      provider: providerName,
    });
    count++;
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
    const provider = createEmailVerificationProvider(workspaceId);
    if (!provider) {
       for (const job of workspaceJobs) {
          await db.update(schema.verificationJobs)
            .set({ status: "failed", lockedAt: null, lockedBy: null, lastError: "Provider failed to initialize" })
            .where(eq(schema.verificationJobs.id, job.id));
       }
       continue;
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

    // TTL logic based on response
    // Wait, the cache wrapper doesn't know the verdict yet when calling. It passes a default TTL.
    // The prompt says: "valid: long TTL, invalid/disposable: longer TTL, catch_all/risky: shorter TTL, unknown: short TTL"
    // We can just use the wrapper, and then manually adjust the TTL in the DB after.
    const result = await verifyEmailsWithCache(provider, emailsToVerify, cacheStore, now);
    
    // Process results
    for (const job of workspaceJobs) {
      const cp = cpMap.get(job.contact_point_id);
      if (!cp) {
        await db.update(schema.verificationJobs)
          .set({ status: "failed", lastError: "Contact point not found", lockedAt: null, lockedBy: null })
          .where(eq(schema.verificationJobs.id, job.id));
        continue;
      }

      const outcome = result.outcomes.find(o => o.email === cp.normalizedValue);
      if (!outcome) {
        await db.update(schema.verificationJobs)
          .set({ status: "failed", lastError: "No outcome from provider", lockedAt: null, lockedBy: null })
          .where(eq(schema.verificationJobs.id, job.id));
        continue;
      }

      if (outcome.code === "unknown") {
        const isDeadLetter = job.attempt_count >= job.max_attempts;
        await db.update(schema.verificationJobs)
          .set({ 
             status: isDeadLetter ? "dead_letter" : "failed", 
             lastError: outcome.providerRawCode,
             lockedAt: null,
             lockedBy: null,
             nextAttemptAt: isDeadLetter ? null : new Date(now.getTime() + Math.pow(2, job.attempt_count) * 60000)
          })
          .where(eq(schema.verificationJobs.id, job.id));
        continue;
      }

      // Update contact point
      await db.update(schema.contactPoints)
        .set({
          verificationStatus: outcome.code,
          verificationProvider: provider.providerName,
          verificationCheckedAt: new Date(outcome.checkedAt),
        })
        .where(eq(schema.contactPoints.id, cp.id));

      // Mark job completed
      await db.update(schema.verificationJobs)
        .set({ status: "completed", lockedAt: null, lockedBy: null })
        .where(eq(schema.verificationJobs.id, job.id));

      totalEmailsVerified++;

      // Adjust TTL based on verdict
      let ttlDays = 30; // valid
      if (outcome.code === "catch_all" || outcome.code === "risky") ttlDays = 7;
      else if (outcome.code === "invalid" || outcome.code === "disposable") ttlDays = 90;
      
      const adjustedExpires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
      await db.update(schema.emailVerifications)
        .set({ expiresAt: adjustedExpires })
        .where(sql`workspace_id = ${workspaceId} AND normalized_email = ${outcome.email} AND provider = ${provider.providerName}`);
      
      // Async trigger compliance & contact selection (could be another background worker, but doing it here directly for now)
      // We will do this via the Compliance runner or manually call the service.
      const { evaluateComplianceForAccount } = await import("@/services/compliance/compliance-evaluator");
      await evaluateComplianceForAccount(workspaceId, cp.accountId);
    }
  }

  return { jobsClaimed: leased.rows.length, emailsVerified: totalEmailsVerified };
}
