import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createEmailVerificationProvider } from "@/infrastructure/providers/provider-factory";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
import { DbVerificationCacheStore } from "@/services/verification/db-verification-cache";
import { verifyEmailsWithCache } from "@/services/verification/email-verification-cache";
import { getDeliveryEnv, getVerificationEnv } from "@/lib/config/env";
import { enqueueVerificationJob } from "@/infrastructure/neon/repositories/verification-queue";
import { actualPriorColdOutreachSql } from "@/infrastructure/neon/repositories/actual-outreach";
import { upsertCampaignMembership } from "@/infrastructure/neon/repositories/campaigns";
import { EMAIL_VERIFICATION_PIPELINE_VERSION } from "@/domain/providers/email-verification-idempotency";
import { runInstantlyImportTick, type InstantlyImportTickResult } from "@/infrastructure/jobs/runners/instantly-import-runner";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;
const HISTORICAL_PREPARATION_BATCH_SIZE = 500;

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
  const createdRawFilter = options.createdSince
    ? sql`AND rc.discovered_at >= ${options.createdSince.toISOString()}`
    : sql``;
  const preparationRows = await db.execute(sql`
    SELECT DISTINCT c.workspace_id, c.id AS campaign_id, a.id AS account_id
    FROM raw_candidates rc
    JOIN campaigns c ON c.id = rc.campaign_id
    JOIN accounts a ON a.id = rc.account_id AND a.workspace_id = c.workspace_id
    LEFT JOIN campaign_memberships cm ON cm.campaign_id = c.id AND cm.account_id = a.id
    WHERE rc.processed = true
      AND c.status = 'active'
      AND c.autopilot_enabled = true
      AND a.status IN ('qualified', 'contactable', 'outreach_ready')
      AND (cm.id IS NULL OR cm.stage = 'discovered')
      ${createdRawFilter}
    ORDER BY a.id
    LIMIT ${HISTORICAL_PREPARATION_BATCH_SIZE}
  `);
  for (const row of preparationRows.rows as Array<{ workspace_id: string; campaign_id: string; account_id: string }>) {
    await upsertCampaignMembership({
      campaignId: row.campaign_id,
      accountId: row.account_id,
      stage: "qualified",
    });
  }

  const complianceRows = await db.execute(sql`
    SELECT DISTINCT c.workspace_id, c.id AS campaign_id, a.id AS account_id
    FROM campaign_memberships cm
    JOIN campaigns c ON c.id = cm.campaign_id
    JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
    WHERE c.status = 'active'
      AND c.autopilot_enabled = true
      AND cm.stage IN ('qualified', 'contact_selected', 'ready')
      AND a.status IN ('qualified', 'contactable', 'outreach_ready')
      AND EXISTS (
        SELECT 1 FROM raw_candidates rc
        WHERE rc.campaign_id = c.id AND rc.account_id = a.id AND rc.processed = true
      )
      AND EXISTS (
        SELECT 1 FROM contact_points cp
        WHERE cp.account_id = a.id
          AND cp.type = 'email'
          AND cp.channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
          AND cp.verification_status IN ('valid', 'unverified', 'unknown')
          AND (cp.verification_status <> 'unknown' OR cp.verification_checked_at IS NULL OR cp.verification_checked_at <= NOW() - INTERVAL '3 days')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM contact_points cp
        JOIN compliance_decisions cd ON cd.contact_point_id = cp.id
        WHERE cp.account_id = a.id
          AND cd.campaign_id = c.id
          AND cd.decision = 'allowed'
          AND cd.superseded_at IS NULL
          AND cp.verification_status = 'valid'
      )
    ORDER BY a.id
    LIMIT ${HISTORICAL_PREPARATION_BATCH_SIZE}
  `);
  const { evaluateComplianceForAccount } = await import("@/services/compliance/compliance-evaluator");
  const preparedAccounts = new Set<string>();
  for (const row of [...preparationRows.rows, ...complianceRows.rows] as Array<{ workspace_id: string; account_id: string }>) {
    const key = `${row.workspace_id}:${row.account_id}`;
    if (preparedAccounts.has(key)) continue;
    preparedAccounts.add(key);
    await evaluateComplianceForAccount(row.workspace_id, row.account_id);
  }

  const createdFilter = options.createdSince
    ? sql`AND cp.created_at >= ${options.createdSince.toISOString()}`
    : sql``;

  // Pick one verification candidate per qualified canonical account.
  const query = sql`
    WITH eligible_accounts AS (
      SELECT DISTINCT cm.account_id, c.workspace_id, cm.campaign_id, cm.selected_contact_point_id
      FROM campaign_memberships cm
      JOIN campaigns c ON cm.campaign_id = c.id
      WHERE cm.stage IN ('qualified', 'contact_selected', 'ready')
        AND c.status = 'active'
        AND cm.contacted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = c.workspace_id AND se.account_id = cm.account_id
        )
        AND NOT ${actualPriorColdOutreachSql({ workspaceId: "c.workspace_id", accountId: "cm.account_id" })}
        AND NOT EXISTS (
          SELECT 1 FROM conversations conv
          WHERE conv.workspace_id = c.workspace_id
            AND conv.account_id = cm.account_id
            AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM meetings m
          JOIN conversations conv ON conv.id = m.conversation_id
          WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id
        )
    ), ranked_candidates AS (
      SELECT DISTINCT ON (ea.campaign_id, ea.account_id)
        cp.id AS contact_point_id,
        ea.workspace_id,
        cp.normalized_value,
        cp.id = ea.selected_contact_point_id AS currently_selected
      FROM eligible_accounts ea
      JOIN contact_points cp ON cp.account_id = ea.account_id
      LEFT JOIN contacts co ON co.id = cp.contact_id
      WHERE cp.type = 'email'
        AND BTRIM(cp.normalized_value) <> ''
        AND cp.channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
        AND cp.last_contacted_at IS NULL
        AND (
          cp.verification_status = 'unverified'
          OR (cp.verification_status = 'unknown' AND (cp.verification_checked_at IS NULL OR cp.verification_checked_at <= NOW() - INTERVAL '3 days'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries se
          WHERE se.workspace_id = ea.workspace_id
            AND (se.account_id = cp.account_id OR se.contact_point_id = cp.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM verification_jobs vj
          WHERE vj.contact_point_id = cp.id
            AND (vj.status IN ('pending', 'processing') OR (vj.status = 'failed' AND vj.attempt_count < vj.max_attempts))
        )
        AND NOT ${actualPriorColdOutreachSql({ workspaceId: "ea.workspace_id", accountId: "ea.account_id" })}
        AND NOT EXISTS (
          SELECT 1 FROM conversations conv
          WHERE conv.workspace_id = ea.workspace_id
            AND conv.account_id = ea.account_id
            AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM meetings m
          JOIN conversations conv ON conv.id = m.conversation_id
          WHERE conv.workspace_id = ea.workspace_id AND conv.account_id = ea.account_id
        )
        ${createdFilter}
      ORDER BY ea.campaign_id, ea.account_id,
        (cp.id = ea.selected_contact_point_id) DESC,
        COALESCE(co.is_decision_maker, false) DESC,
        cp.is_personal_or_named DESC,
        CASE
          WHEN COALESCE(co.role_type, cp.label, '') ILIKE '%owner%' OR COALESCE(co.job_title, '') ILIKE '%titular%' OR COALESCE(co.seniority, '') ILIKE '%owner%' THEN 1
          WHEN COALESCE(co.role_type, cp.label, '') ILIKE '%purchasing%' OR COALESCE(co.role_type, cp.label, '') ILIKE '%compras%' OR COALESCE(co.job_title, '') ILIKE '%buyer%' THEN 2
          WHEN COALESCE(co.role_type, cp.label, '') ILIKE '%manager%' OR COALESCE(co.job_title, '') ILIKE '%director%' OR COALESCE(co.job_title, '') ILIKE '%gerente%' THEN 3
          WHEN COALESCE(co.role_type, cp.label, '') ILIKE '%professional%' OR COALESCE(co.job_title, '') ILIKE '%pharmacist%' THEN 4
          ELSE 10
        END,
        cp.is_generic ASC,
        cp.priority_score DESC,
        cp.created_at ASC
    )
    SELECT contact_point_id, workspace_id, normalized_value
    FROM ranked_candidates
    ORDER BY currently_selected DESC, contact_point_id
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

export interface HistoricalBackfillProgress {
  verificationCandidatesRemaining: number;
  verificationJobsPending: number;
  eligibleValidContactsRemaining: number;
  instantlyImportJobsPending: number;
  instantlyDeferredDueToPlanLimit: number;
}

export async function getHistoricalBackfillProgress(): Promise<HistoricalBackfillProgress> {
  const db = getDb();
  const providerCampaignId = getDeliveryEnv().INSTANTLY_CAMPAIGN_ID;
  const verificationProvider = getVerificationEnv().EMAIL_VERIFICATION_PROVIDER;
  const result = await db.execute(sql`
    SELECT
      (
        SELECT COUNT(DISTINCT cm.account_id)::int
        FROM campaign_memberships cm
        JOIN campaigns c ON c.id = cm.campaign_id
        JOIN contact_points cp ON cp.account_id = cm.account_id AND cp.type = 'email'
        WHERE c.status = 'active' AND c.autopilot_enabled = true
          AND cm.stage IN ('qualified', 'contact_selected', 'ready')
          AND cp.channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
          AND cp.verification_status IN ('unverified', 'unknown')
          AND (cp.verification_status <> 'unknown' OR cp.verification_checked_at IS NULL OR cp.verification_checked_at <= NOW() - INTERVAL '3 days')
          AND NOT EXISTS (
            SELECT 1 FROM verification_jobs vj
            WHERE vj.contact_point_id = cp.id
              AND (vj.status IN ('pending', 'processing') OR (vj.status = 'failed' AND vj.attempt_count < vj.max_attempts))
          )
          AND NOT EXISTS (SELECT 1 FROM suppression_entries se WHERE se.workspace_id = c.workspace_id AND (se.account_id = cm.account_id OR se.contact_point_id = cp.id))
          AND NOT ${actualPriorColdOutreachSql({ workspaceId: "c.workspace_id", accountId: "cm.account_id" })}
          AND NOT EXISTS (SELECT 1 FROM conversations conv WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed'))
          AND NOT EXISTS (SELECT 1 FROM meetings m JOIN conversations conv ON conv.id = m.conversation_id WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id)
      ) AS verification_candidates_remaining,
      (
        SELECT COUNT(*)::int
        FROM verification_jobs vj
        WHERE vj.provider = ${verificationProvider}
          AND (vj.status IN ('pending', 'processing') OR (vj.status = 'failed' AND vj.attempt_count < vj.max_attempts))
      ) AS verification_jobs_pending,
      (
        SELECT COUNT(DISTINCT cp.id)::int
        FROM campaign_memberships cm
        JOIN campaigns c ON c.id = cm.campaign_id
        JOIN contact_points cp ON cp.id = cm.selected_contact_point_id AND cp.type = 'email'
        JOIN compliance_decisions cd ON cd.campaign_id = cm.campaign_id
          AND cd.account_id = cm.account_id AND cd.contact_point_id = cp.id
          AND cd.decision = 'allowed' AND cd.superseded_at IS NULL
        WHERE c.status = 'active' AND c.autopilot_enabled = true
          AND cm.stage IN ('qualified', 'contact_selected', 'ready')
          AND cp.verification_status = 'valid'
          AND cp.channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
          AND cp.last_contacted_at IS NULL AND cm.contacted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM suppression_entries se WHERE se.workspace_id = c.workspace_id AND (se.account_id = cm.account_id OR se.contact_point_id = cp.id))
          AND NOT ${actualPriorColdOutreachSql({ workspaceId: "c.workspace_id", accountId: "cm.account_id" })}
          AND NOT EXISTS (SELECT 1 FROM conversations conv WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed'))
          AND NOT EXISTS (SELECT 1 FROM meetings m JOIN conversations conv ON conv.id = m.conversation_id WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id)
          AND NOT EXISTS (
            SELECT 1 FROM instantly_lead_imports ili
            WHERE ili.workspace_id = c.workspace_id AND ili.account_id = cm.account_id
              AND ili.contact_point_id = cp.id AND ili.provider_campaign_id = ${providerCampaignId}
              AND ili.status IN ('instantly_added', 'skipped_existing', 'deferred_due_to_plan_limit')
          )
      ) AS eligible_valid_contacts_remaining,
      (
        SELECT COUNT(*)::int FROM instantly_lead_imports
        WHERE provider_campaign_id = ${providerCampaignId}
          AND status IN ('eligible', 'instantly_queued', 'failed', 'deferred')
          AND attempt_count < max_attempts
      ) AS instantly_import_jobs_pending,
      (
        SELECT COUNT(*)::int FROM instantly_lead_imports
        WHERE provider_campaign_id = ${providerCampaignId}
          AND status = 'deferred_due_to_plan_limit'
      ) AS instantly_deferred_due_to_plan_limit
  `);
  const counts = result.rows[0] as Record<string, number | string> | undefined;
  return {
    verificationCandidatesRemaining: Number(counts?.verification_candidates_remaining ?? 0),
    verificationJobsPending: Number(counts?.verification_jobs_pending ?? 0),
    eligibleValidContactsRemaining: Number(counts?.eligible_valid_contacts_remaining ?? 0),
    instantlyImportJobsPending: Number(counts?.instantly_import_jobs_pending ?? 0),
    instantlyDeferredDueToPlanLimit: Number(counts?.instantly_deferred_due_to_plan_limit ?? 0),
  };
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
          OR ${actualPriorColdOutreachSql({
            workspaceId: sql`${workspaceId}`,
            accountId: "cp.account_id",
            contactPointId: "cp.id",
            normalizedEmail: "cp.normalized_value",
          })}
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
