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
import { runInstantlyImportTick, type InstantlyImportTickResult } from "@/infrastructure/jobs/runners/instantly-import-runner";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;

export interface VerificationRunnerResult {
  jobsClaimed: number;
  emailsVerified: number;
  millionVerifierStatus: "ready" | "missing_configuration" | "unhealthy" | "disabled" | "not_selected";
  instantly?: InstantlyImportTickResult;
}

function getMillionVerifierStatus(
  providerName: string,
  configured: boolean,
  failures = 0,
): VerificationRunnerResult["millionVerifierStatus"] {
  if (providerName === "disabled") return "disabled";
  if (providerName !== "millionverifier") return "not_selected";
  if (!configured) return "missing_configuration";
  return failures > 0 ? "unhealthy" : "ready";
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

export async function enqueueVerificationJobs(options: { createdSince?: Date } = {}): Promise<number> {
  const db = getDb();
  const createdFilter = options.createdSince
    ? sql`AND cp.created_at >= ${options.createdSince.toISOString()}`
    : sql``;
  
  // Requeue unverified contacts and unknown results after their short cache window expires.
  // Limit to 500 per tick to avoid blowing up the query
  const query = sql`
    WITH eligible_accounts AS (
      SELECT DISTINCT cm.account_id, cm.workspace_id, cm.selected_contact_point_id
      FROM campaign_memberships cm
      JOIN campaigns c ON cm.campaign_id = c.id
      WHERE cm.stage IN ('qualified', 'ready')
        AND c.status = 'active'
        AND cm.selected_contact_point_id IS NOT NULL
        AND cm.contacted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = cm.workspace_id AND se.account_id = cm.account_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach_queue oq
          WHERE oq.workspace_id = cm.workspace_id AND oq.account_id = cm.account_id AND oq.channel = 'email'
        )
        AND NOT EXISTS (
          SELECT 1 FROM conversations conv
          WHERE conv.workspace_id = cm.workspace_id
            AND conv.account_id = cm.account_id
            AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM meetings m
          JOIN conversations conv ON conv.id = m.conversation_id
          WHERE conv.workspace_id = cm.workspace_id AND conv.account_id = cm.account_id
        )
    )
    SELECT cp.id as contact_point_id, ea.workspace_id, cp.normalized_value
    FROM contact_points cp
    JOIN eligible_accounts ea ON cp.account_id = ea.account_id AND cp.id = ea.selected_contact_point_id
    WHERE cp.type = 'email'
      AND BTRIM(cp.normalized_value) <> ''
      AND cp.last_contacted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM suppression_entries se
        WHERE se.workspace_id = ea.workspace_id
          AND (se.account_id = cp.account_id OR se.contact_point_id = cp.id)
      )
      AND (
        cp.verification_status = 'unverified'
        OR (cp.verification_status = 'unknown' AND (cp.verification_checked_at IS NULL OR cp.verification_checked_at <= NOW() - INTERVAL '3 days'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM verification_jobs vj
        WHERE vj.contact_point_id = cp.id
          AND vj.status IN ('pending', 'processing')
      )
      ${createdFilter}
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

export async function runVerificationCronTick(
  maxJobs: number = BATCH_SIZE,
  options: { createdSince?: Date; backfillAll?: boolean } = {},
): Promise<VerificationRunnerResult> {
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

  if (leased.rows.length === 0) {
    return {
      jobsClaimed: 0,
      emailsVerified: 0,
      millionVerifierStatus: getMillionVerifierStatus(providerName, Boolean(env.MILLION_VERIFIER ?? env.MILLIONVERIFIER_API_KEY)),
      instantly: await runInstantlyImportTick({
        ...(options.backfillAll
          ? { backfillAll: true }
          : options.createdSince
            ? { createdSince: options.createdSince }
            : { processQueueOnly: true }),
        now,
      }),
    };
  }

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
    return {
      jobsClaimed: leased.rows.length,
      emailsVerified: 0,
      millionVerifierStatus: "disabled",
      instantly: await runInstantlyImportTick({
        ...(options.backfillAll
          ? { backfillAll: true }
          : options.createdSince
            ? { createdSince: options.createdSince }
            : { processQueueOnly: true }),
        now,
      }),
    };
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
  let verificationProviderFailures = 0;
  const verifiedContactPointIds = new Set<string>();

  for (const [workspaceId, workspaceJobs] of jobsByWorkspace.entries()) {
    const workspaceJobIds = workspaceJobs.map((job) => job.id);
    const blockedRows = await db.execute(sql`
      SELECT vj.id
      FROM verification_jobs vj
      JOIN contact_points cp ON cp.id = vj.contact_point_id
      WHERE vj.id IN ${workspaceJobIds}
        AND vj.workspace_id = ${workspaceId}
        AND (
          cp.last_contacted_at IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM suppression_entries se
            WHERE se.workspace_id = ${workspaceId}
              AND (se.account_id = cp.account_id OR se.contact_point_id = cp.id)
          )
          OR EXISTS (
            SELECT 1 FROM campaign_memberships cm
            JOIN campaigns c ON c.id = cm.campaign_id
            WHERE c.workspace_id = ${workspaceId}
              AND cm.account_id = cp.account_id
              AND cm.contacted_at IS NOT NULL
          )
          OR EXISTS (
            SELECT 1 FROM outreach_queue oq
            WHERE oq.workspace_id = ${workspaceId}
              AND oq.account_id = cp.account_id
              AND oq.channel = 'email'
          )
          OR EXISTS (
            SELECT 1 FROM conversations conv
            WHERE conv.workspace_id = ${workspaceId}
              AND conv.account_id = cp.account_id
              AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
          )
          OR EXISTS (
            SELECT 1 FROM meetings m
            JOIN conversations conv ON conv.id = m.conversation_id
            WHERE conv.workspace_id = ${workspaceId} AND conv.account_id = cp.account_id
          )
        )
    `);
    const blockedJobIds = new Set(blockedRows.rows.map((row) => String((row as { id: string }).id)));
    for (const job of workspaceJobs) {
      if (!blockedJobIds.has(job.id)) continue;
      await db.update(schema.verificationJobs)
        .set({
          status: "suppressed",
          lastError: "Account suppressed or prior cold outreach exists.",
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
        })
        .where(eq(schema.verificationJobs.id, job.id));
    }
    const safeWorkspaceJobs = workspaceJobs.filter((job) => !blockedJobIds.has(job.id));
    if (safeWorkspaceJobs.length === 0) continue;

    let provider;
    try {
      provider = createEmailVerificationProvider(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deferVerificationJobs(safeWorkspaceJobs, message, now);
      throw error;
    }

    const cacheStore = new DbVerificationCacheStore(workspaceId, provider.providerName);
    
    // Map jobs to contact points
    const contactPointIds = safeWorkspaceJobs.map(j => j.contact_point_id);
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
      verificationProviderFailures += workspaceJobs.length;
      if (error instanceof ProviderBudgetExceededError) {
        await deferVerificationJobs(safeWorkspaceJobs, message, now, error.retryAt);
        continue;
      }
        await deferVerificationJobs(safeWorkspaceJobs, message, now);
      continue;
    }
    
    // Process results
    for (const job of safeWorkspaceJobs) {
      const cp = cpMap.get(job.contact_point_id);
      if (!cp) {
        verificationProviderFailures++;
        await deferVerificationJobs([job], "Contact point not found", now);
        continue;
      }

      const outcome = result.outcomes.find(o => o.email === cp.normalizedValue);
      if (!outcome) {
        verificationProviderFailures++;
        await deferVerificationJobs([job], "No outcome from provider", now);
        continue;
      }

      if (outcome.retryable) {
        verificationProviderFailures++;
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
      if (outcome.code === "valid") verifiedContactPointIds.add(cp.id);
    }
  }

  const instantly = await runInstantlyImportTick({
    ...(verifiedContactPointIds.size > 0 ? { contactPointIds: Array.from(verifiedContactPointIds) } : {}),
    ...(options.backfillAll
      ? { backfillAll: true }
      : options.createdSince
        ? { createdSince: options.createdSince }
        : verifiedContactPointIds.size === 0
          ? { processQueueOnly: true }
          : {}),
    now,
  });
  return {
    jobsClaimed: leased.rows.length,
    emailsVerified: totalEmailsVerified,
    millionVerifierStatus: getMillionVerifierStatus(
      providerName,
      Boolean(env.MILLION_VERIFIER ?? env.MILLIONVERIFIER_API_KEY),
      verificationProviderFailures,
    ),
    instantly,
  };
}
