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
import type { VerificationStatus } from "@/domain/contacts/types";
import { runInstantlyImportTick, type InstantlyImportTickResult } from "@/infrastructure/jobs/runners/instantly-import-runner";
import {
  EMAIL_CHANNEL_ELIGIBLE_STATUSES,
  emailChannelEligibilitySql,
  VITALCAP_B2B_EMAIL_POLICY_VERSION,
} from "@/services/compliance/email-channel-policy";

const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MINUTES = 15;
const HISTORICAL_PREPARATION_BATCH_SIZE = 500;
const CURRENT_VERIFICATION_TTL_DAYS = 30;

export interface VerificationRunnerResult {
  jobsClaimed: number;
  emailsVerified: number;
  cacheHits?: number;
  verificationValid?: number;
  verificationInvalid?: number;
  verificationRisky?: number;
  verificationCatchAll?: number;
  millionVerifierStatus: "ready" | "missing_configuration" | "unhealthy" | "disabled" | "not_selected";
  instantly?: InstantlyImportTickResult;
}

export interface ProviderDisabledVerificationRepairResult {
  inspected: number;
  resolvedFromCurrentResult: number;
  reactivated: number;
  suppressed: number;
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

function isCurrentVerification(status: string, checkedAt: Date | string | null, now: Date): boolean {
  if (!checkedAt || status === "unverified" || status === "unknown") return false;
  const ttlDays = status === "catch_all" || status === "risky"
    ? 7
    : status === "invalid" || status === "disposable" || status === "bounced"
      ? 90
      : CURRENT_VERIFICATION_TTL_DAYS;
  const checkedAtMs = checkedAt instanceof Date ? checkedAt.getTime() : Date.parse(checkedAt);
  return Number.isFinite(checkedAtMs) && checkedAtMs > now.getTime() - ttlDays * 24 * 60 * 60_000;
}

export async function repairProviderDisabledVerificationJobs(
  limit = HISTORICAL_PREPARATION_BATCH_SIZE,
  now = new Date(),
): Promise<ProviderDisabledVerificationRepairResult> {
  const env = getVerificationEnv();
  const result: ProviderDisabledVerificationRepairResult = {
    inspected: 0,
    resolvedFromCurrentResult: 0,
    reactivated: 0,
    suppressed: 0,
  };
  if (env.EMAIL_VERIFICATION_PROVIDER !== "millionverifier") return result;

  const db = getDb();
  const lockExpiry = new Date(now.getTime() - LOCK_TIMEOUT_MINUTES * 60_000);
  const rows = await db.execute(sql`
    SELECT
      vj.id,
      vj.workspace_id,
      cp.id AS contact_point_id,
      cp.account_id,
      cp.normalized_value,
      cp.verification_status,
      cp.verification_checked_at,
      cp.last_contacted_at,
      cache.status AS cached_status,
      cache.checked_at AS cache_checked_at,
      EXISTS (
        SELECT 1 FROM suppression_entries se
        WHERE se.workspace_id = vj.workspace_id
          AND (se.account_id = cp.account_id OR se.contact_point_id = cp.id)
      )
      OR cp.last_contacted_at IS NOT NULL
      OR cp.type <> 'email'
      OR BTRIM(cp.normalized_value) = ''
      OR cp.channel_eligibility IN ('opted_out', 'blocked')
      OR NOT EXISTS (
        SELECT 1
        FROM campaign_memberships cm
        JOIN campaigns c ON c.id = cm.campaign_id AND c.workspace_id = vj.workspace_id
        JOIN raw_candidates rc ON rc.campaign_id = c.id AND rc.account_id = cm.account_id AND rc.processed = true
        WHERE cm.account_id = cp.account_id
          AND cm.contacted_at IS NULL
          AND cm.stage IN ('qualified', 'contact_selected', 'ready')
          AND c.status = 'active'
          AND c.autopilot_enabled = true
      )
      OR EXISTS (
        SELECT 1 FROM campaign_memberships cm
        JOIN campaigns c ON c.id = cm.campaign_id AND c.workspace_id = vj.workspace_id
        WHERE cm.account_id = cp.account_id AND cm.contacted_at IS NOT NULL
      )
      OR ${actualPriorColdOutreachSql({
        workspaceId: "vj.workspace_id",
        accountId: "cp.account_id",
        contactPointId: "cp.id",
        normalizedEmail: "cp.normalized_value",
      })}
      OR EXISTS (
        SELECT 1 FROM conversations conv
        WHERE conv.workspace_id = vj.workspace_id
          AND conv.account_id = cp.account_id
          AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
      )
      OR EXISTS (
        SELECT 1 FROM meetings m
        JOIN conversations conv ON conv.id = m.conversation_id
        WHERE conv.workspace_id = vj.workspace_id AND conv.account_id = cp.account_id
      ) AS obsolete
    FROM verification_jobs vj
    JOIN contact_points cp ON cp.id = vj.contact_point_id AND cp.workspace_id = vj.workspace_id
    JOIN accounts a ON a.id = cp.account_id AND a.workspace_id = vj.workspace_id
    LEFT JOIN LATERAL (
      SELECT ev.status, ev.checked_at
      FROM email_verifications ev
      WHERE ev.workspace_id = vj.workspace_id
        AND ev.normalized_email = LOWER(TRIM(cp.normalized_value))
        AND ev.provider = ${env.EMAIL_VERIFICATION_PROVIDER}
        AND ev.pipeline_version = ${EMAIL_VERIFICATION_PIPELINE_VERSION}
        AND (ev.expires_at IS NULL OR ev.expires_at > ${now.toISOString()})
      ORDER BY ev.checked_at DESC
      LIMIT 1
    ) cache ON true
    WHERE vj.status = 'provider_disabled'
      AND (vj.locked_at IS NULL OR vj.locked_at < ${lockExpiry.toISOString()})
    ORDER BY vj.created_at ASC
    LIMIT ${limit}
  `);

  const { evaluateComplianceForAccount } = await import("@/services/compliance/compliance-evaluator");
  for (const row of rows.rows as Array<{
    id: string;
    workspace_id: string;
    contact_point_id: string;
    account_id: string;
    verification_status: string;
    verification_checked_at: Date | string | null;
    cached_status: string | null;
    cache_checked_at: Date | string | null;
    obsolete: boolean;
  }>) {
    result.inspected++;
    if (row.obsolete) {
      await db.update(schema.verificationJobs).set({
        status: "suppressed",
        lastError: "Historical verification job is no longer eligible or has prior contact activity.",
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
      }).where(eq(schema.verificationJobs.id, row.id));
      result.suppressed++;
      continue;
    }

    const cachedStatus = row.cached_status;
    const currentStatus = cachedStatus ?? row.verification_status;
    const currentCheckedAt = row.cache_checked_at ?? row.verification_checked_at;
    if (isCurrentVerification(currentStatus, currentCheckedAt, now)) {
      if (cachedStatus) {
        await db.update(schema.contactPoints).set({
          verificationStatus: cachedStatus as VerificationStatus,
          verificationProvider: env.EMAIL_VERIFICATION_PROVIDER,
          verificationCheckedAt: currentCheckedAt ? new Date(currentCheckedAt) : now,
          updatedAt: now,
        }).where(eq(schema.contactPoints.id, row.contact_point_id));
      }
      const { repairVerifiedAutopilotEmailMetadata, evaluateComplianceForAccount } = await import("@/services/compliance/compliance-evaluator");
      if (currentStatus === "valid") {
        await repairVerifiedAutopilotEmailMetadata(row.workspace_id, row.account_id);
      }
      await evaluateComplianceForAccount(row.workspace_id, row.account_id);
      if (currentStatus === "valid") {
        await runInstantlyImportTick({ contactPointIds: [row.contact_point_id], now });
      }
      await db.update(schema.verificationJobs).set({
        provider: env.EMAIL_VERIFICATION_PROVIDER,
        status: "completed",
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        lastError: null,
      }).where(eq(schema.verificationJobs.id, row.id));
      result.resolvedFromCurrentResult++;
      continue;
    }

    const needsVerification = row.verification_status === "unverified" || row.verification_status === "unknown";
    if (!needsVerification) {
      await db.update(schema.verificationJobs).set({
        status: "suppressed",
        lastError: "Historical verification job no longer needs verification.",
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
      }).where(eq(schema.verificationJobs.id, row.id));
      result.suppressed++;
      continue;
    }

    await db.update(schema.verificationJobs).set({
      provider: env.EMAIL_VERIFICATION_PROVIDER,
      status: "pending",
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    }).where(eq(schema.verificationJobs.id, row.id));
    result.reactivated++;
  }

  return result;
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
        WHERE cp.account_id = a.id AND cp.workspace_id = a.workspace_id
          AND cp.type = 'email'
      )
      AND NOT EXISTS (
        SELECT 1 FROM contact_points cp
        JOIN compliance_decisions cd ON cd.contact_point_id = cp.id
          AND cd.workspace_id = c.workspace_id
          AND cd.campaign_id = c.id
          AND cd.superseded_at IS NULL
          AND cd.policy_version = ${VITALCAP_B2B_EMAIL_POLICY_VERSION}
        WHERE cp.account_id = a.id AND cp.workspace_id = a.workspace_id AND cp.type = 'email'
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
      JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
      WHERE cm.stage IN ('qualified', 'contact_selected', 'ready')
        AND c.status = 'active'
        AND c.autopilot_enabled = true
        AND a.status IN ('qualified', 'contactable', 'outreach_ready')
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
      JOIN contact_points cp ON cp.account_id = ea.account_id AND cp.workspace_id = ea.workspace_id
      LEFT JOIN contacts co ON co.id = cp.contact_id AND co.workspace_id = ea.workspace_id
      WHERE cp.type = 'email'
        AND BTRIM(cp.normalized_value) <> ''
        AND LOWER(TRIM(cp.normalized_value)) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
        AND cp.channel_eligibility NOT IN ('opted_out', 'blocked')
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
  verificationJobsProcessing: number;
  verificationProviderDisabledJobs: number;
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
        JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
        JOIN contact_points cp ON cp.account_id = cm.account_id AND cp.workspace_id = a.workspace_id AND cp.type = 'email'
        WHERE c.status = 'active' AND c.autopilot_enabled = true
          AND cm.stage IN ('qualified', 'contact_selected', 'ready')
          AND cp.channel_eligibility NOT IN ('opted_out', 'blocked')
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
          AND (vj.status = 'pending' OR (vj.status = 'failed' AND vj.attempt_count < vj.max_attempts))
      ) AS verification_jobs_pending,
      (
        SELECT COUNT(*)::int
        FROM verification_jobs vj
        WHERE vj.provider = ${verificationProvider} AND vj.status = 'processing'
      ) AS verification_jobs_processing,
      (
        SELECT COUNT(*)::int
        FROM verification_jobs vj
        WHERE vj.provider = 'disabled' AND vj.status = 'provider_disabled'
      ) AS verification_provider_disabled_jobs,
      (
        SELECT COUNT(DISTINCT cp.id)::int
        FROM campaign_memberships cm
        JOIN campaigns c ON c.id = cm.campaign_id
        JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
        JOIN contact_points cp ON cp.id = cm.selected_contact_point_id
          AND cp.account_id = a.id AND cp.workspace_id = a.workspace_id AND cp.type = 'email'
        JOIN compliance_decisions cd ON cd.campaign_id = cm.campaign_id
          AND cd.workspace_id = c.workspace_id
          AND cd.account_id = cm.account_id AND cd.contact_point_id = cp.id
          AND cd.decision = 'allowed' AND cd.superseded_at IS NULL
        WHERE c.status = 'active' AND c.autopilot_enabled = true
          AND cm.stage IN ('qualified', 'contact_selected', 'ready')
          AND cp.verification_status = 'valid'
          AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
          AND cp.last_contacted_at IS NULL AND cm.contacted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM suppression_entries se WHERE se.workspace_id = c.workspace_id AND (se.account_id = cm.account_id OR se.contact_point_id = cp.id))
          AND NOT ${actualPriorColdOutreachSql({ workspaceId: "c.workspace_id", accountId: "cm.account_id" })}
          AND NOT EXISTS (SELECT 1 FROM conversations conv WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed'))
          AND NOT EXISTS (SELECT 1 FROM meetings m JOIN conversations conv ON conv.id = m.conversation_id WHERE conv.workspace_id = c.workspace_id AND conv.account_id = cm.account_id)
          AND NOT EXISTS (
            SELECT 1 FROM instantly_lead_imports ili
            WHERE ili.workspace_id = c.workspace_id AND ili.account_id = cm.account_id
              AND ili.contact_point_id = cp.id AND ili.provider_campaign_id = ${providerCampaignId}
              AND (
                ili.status IN ('instantly_added', 'skipped_existing', 'needs_campaign_move', 'reconciliation_required', 'deferred_due_to_plan_limit')
                OR (ili.status = 'failed' AND ili.attempt_count >= ili.max_attempts)
              )
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
    verificationJobsProcessing: Number(counts?.verification_jobs_processing ?? 0),
    verificationProviderDisabledJobs: Number(counts?.verification_provider_disabled_jobs ?? 0),
    eligibleValidContactsRemaining: Number(counts?.eligible_valid_contacts_remaining ?? 0),
    instantlyImportJobsPending: Number(counts?.instantly_import_jobs_pending ?? 0),
    instantlyDeferredDueToPlanLimit: Number(counts?.instantly_deferred_due_to_plan_limit ?? 0),
  };
}

export interface HistoricalBackfillPreview {
  historicalAccounts: number;
  accountsWithEmail: number;
  channelUnknown: number;
  channelEligible: number;
  channelBlocked: number;
  unverified: number;
  verificationValid: number;
  verificationInvalid: number;
  verificationRisky: number;
  verificationCatchAll: number;
  providerDisabledJobs: number;
  verificationJobsPending: number;
  verificationJobsProcessing: number;
  complianceMissing: number;
  complianceAllowed: number;
  complianceReviewRequired: number;
  complianceBlocked: number;
  selectedContacts: number;
  readyMemberships: number;
  eligibleInstantly: number;
  alreadyImportedTarget: number;
  needsCampaignMove: number;
  failedImports: number;
  reconciliationRequired: number;
  instantlyDeferredDueToPlanLimit: number;
  deferred: number;
  planCapacity: number;
}

export async function getHistoricalBackfillPreview(): Promise<HistoricalBackfillPreview> {
  const db = getDb();
  const providerCampaignId = getDeliveryEnv().INSTANTLY_CAMPAIGN_ID;
  const verificationProvider = getVerificationEnv().EMAIL_VERIFICATION_PROVIDER;
  const hardLimit = getDeliveryEnv().INSTANTLY_MAX_UPLOADED_CONTACTS;
  const result = await db.execute(sql`
    WITH scope AS (
      SELECT DISTINCT c.workspace_id, c.id AS campaign_id, a.id AS account_id, cm.id AS membership_id,
        cm.stage, cm.selected_contact_point_id
      FROM campaign_memberships cm
      JOIN campaigns c ON c.id = cm.campaign_id
      JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
      WHERE c.status = 'active' AND c.autopilot_enabled = true
    ), points AS (
      SELECT s.*, cp.id AS contact_point_id, cp.channel_eligibility, cp.verification_status,
        cd.id AS compliance_decision_id, cd.decision AS compliance_decision
      FROM scope s
      LEFT JOIN contact_points cp ON cp.account_id = s.account_id
        AND cp.workspace_id = s.workspace_id AND cp.type = 'email'
      LEFT JOIN compliance_decisions cd ON cd.workspace_id = s.workspace_id
        AND cd.campaign_id = s.campaign_id AND cd.account_id = s.account_id
        AND cd.contact_point_id = cp.id AND cd.channel = 'email' AND cd.superseded_at IS NULL
    ), imported AS (
      SELECT
        COUNT(*) FILTER (WHERE status IN ('instantly_added', 'skipped_existing'))::int AS already_imported_target,
        COUNT(*) FILTER (WHERE status IN ('deferred', 'deferred_due_to_plan_limit'))::int AS deferred,
        COUNT(*) FILTER (WHERE status = 'needs_campaign_move')::int AS needs_campaign_move,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempt_count >= max_attempts)::int AS failed_imports,
        COUNT(*) FILTER (WHERE status = 'reconciliation_required')::int AS reconciliation_required,
        COUNT(*) FILTER (WHERE status = 'instantly_added')::int AS uploaded
      FROM instantly_lead_imports
      WHERE provider_campaign_id = ${providerCampaignId}
    )
    SELECT
      (SELECT COUNT(DISTINCT account_id)::int FROM scope) AS historical_accounts,
      COUNT(DISTINCT account_id) FILTER (WHERE contact_point_id IS NOT NULL)::int AS accounts_with_email,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE channel_eligibility = 'unknown')::int AS channel_unknown,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE channel_eligibility = ANY(${[...EMAIL_CHANNEL_ELIGIBLE_STATUSES]}::text[]))::int AS channel_eligible,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE channel_eligibility IN ('opted_out', 'blocked'))::int AS channel_blocked,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE verification_status IN ('unverified', 'unknown'))::int AS unverified,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE verification_status = 'valid')::int AS verification_valid,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE verification_status IN ('invalid', 'disposable', 'bounced'))::int AS verification_invalid,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE verification_status = 'risky')::int AS verification_risky,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE verification_status = 'catch_all')::int AS verification_catch_all,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE compliance_decision_id IS NULL)::int AS compliance_missing,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE compliance_decision = 'allowed')::int AS compliance_allowed,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE compliance_decision = 'review_required')::int AS compliance_review_required,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE compliance_decision = 'blocked')::int AS compliance_blocked,
      COUNT(DISTINCT contact_point_id) FILTER (WHERE contact_point_id = selected_contact_point_id)::int AS selected_contacts,
      COUNT(DISTINCT membership_id) FILTER (WHERE stage = 'ready')::int AS ready_memberships,
      (SELECT COUNT(*)::int FROM verification_jobs WHERE provider = 'disabled' AND status = 'provider_disabled') AS provider_disabled_jobs,
      (SELECT COUNT(*)::int FROM verification_jobs WHERE provider = ${verificationProvider} AND status IN ('pending', 'failed') AND attempt_count < max_attempts) AS verification_jobs_pending,
      (SELECT COUNT(*)::int FROM verification_jobs WHERE provider = ${verificationProvider} AND status = 'processing') AS verification_jobs_processing,
      (SELECT already_imported_target FROM imported) AS already_imported_target,
      (SELECT needs_campaign_move FROM imported) AS needs_campaign_move,
      (SELECT failed_imports FROM imported) AS failed_imports,
      (SELECT reconciliation_required FROM imported) AS reconciliation_required,
      (SELECT deferred FROM imported) AS deferred,
      GREATEST(0, ${hardLimit} - (SELECT uploaded FROM imported))::int AS plan_capacity
    FROM points
  `);
  const values = result.rows[0] as Record<string, string | number> | undefined;
  const progress = await getHistoricalBackfillProgress();
  return {
    historicalAccounts: Number(values?.historical_accounts ?? 0),
    accountsWithEmail: Number(values?.accounts_with_email ?? 0),
    channelUnknown: Number(values?.channel_unknown ?? 0),
    channelEligible: Number(values?.channel_eligible ?? 0),
    channelBlocked: Number(values?.channel_blocked ?? 0),
    unverified: Number(values?.unverified ?? 0),
    verificationValid: Number(values?.verification_valid ?? 0),
    verificationInvalid: Number(values?.verification_invalid ?? 0),
    verificationRisky: Number(values?.verification_risky ?? 0),
    verificationCatchAll: Number(values?.verification_catch_all ?? 0),
    providerDisabledJobs: Number(values?.provider_disabled_jobs ?? 0),
    verificationJobsPending: Number(values?.verification_jobs_pending ?? 0),
    verificationJobsProcessing: Number(values?.verification_jobs_processing ?? 0),
    complianceMissing: Number(values?.compliance_missing ?? 0),
    complianceAllowed: Number(values?.compliance_allowed ?? 0),
    complianceReviewRequired: Number(values?.compliance_review_required ?? 0),
    complianceBlocked: Number(values?.compliance_blocked ?? 0),
    selectedContacts: Number(values?.selected_contacts ?? 0),
    readyMemberships: Number(values?.ready_memberships ?? 0),
    eligibleInstantly: progress.eligibleValidContactsRemaining,
    alreadyImportedTarget: Number(values?.already_imported_target ?? 0),
    needsCampaignMove: Number(values?.needs_campaign_move ?? 0),
    failedImports: Number(values?.failed_imports ?? 0),
    reconciliationRequired: Number(values?.reconciliation_required ?? 0),
    instantlyDeferredDueToPlanLimit: progress.instantlyDeferredDueToPlanLimit,
    deferred: Number(values?.deferred ?? 0) + progress.instantlyDeferredDueToPlanLimit,
    planCapacity: Number(values?.plan_capacity ?? 0),
  };
}

export async function runVerificationCronTick(
  maxJobs: number = BATCH_SIZE,
  options: { createdSince?: Date; backfillAll?: boolean; skipInstantlyImport?: boolean } = {},
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
    const instantly = options.skipInstantlyImport ? undefined : await runInstantlyImportTick({
      ...(options.backfillAll
        ? { backfillAll: true }
        : options.createdSince
          ? { createdSince: options.createdSince }
          : { processQueueOnly: true }),
      now,
    });
    return {
      jobsClaimed: 0,
      emailsVerified: 0,
      millionVerifierStatus: getMillionVerifierStatus(providerName, Boolean(env.MILLION_VERIFIER ?? env.MILLIONVERIFIER_API_KEY)),
      ...(instantly ? { instantly } : {}),
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
    const instantly = options.skipInstantlyImport ? undefined : await runInstantlyImportTick({
      ...(options.backfillAll
        ? { backfillAll: true }
        : options.createdSince
          ? { createdSince: options.createdSince }
          : { processQueueOnly: true }),
      now,
    });
    return {
      jobsClaimed: leased.rows.length,
      emailsVerified: 0,
      millionVerifierStatus: "disabled",
      ...(instantly ? { instantly } : {}),
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
  let totalCacheHits = 0;
  let verificationValid = 0;
  let verificationInvalid = 0;
  let verificationRisky = 0;
  let verificationCatchAll = 0;
  let verificationProviderFailures = 0;
  const verifiedContactPointIds = new Set<string>();
  const jobsToComplete: Array<{ id: string; costUsd: number }> = [];

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
      totalCacheHits += result.cacheHits;
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

      if (outcome.code === "valid") verificationValid++;
      else if (outcome.code === "invalid") verificationInvalid++;
      else if (outcome.code === "risky") verificationRisky++;
      else if (outcome.code === "catch_all") verificationCatchAll++;

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
      
      const { repairVerifiedAutopilotEmailMetadata, evaluateComplianceForAccount } = await import("@/services/compliance/compliance-evaluator");
      if (outcome.code === "valid") {
        await repairVerifiedAutopilotEmailMetadata(workspaceId, cp.accountId);
      }
      await evaluateComplianceForAccount(workspaceId, cp.accountId);
      if (outcome.code === "valid") verifiedContactPointIds.add(cp.id);
      jobsToComplete.push({ id: job.id, costUsd: outcome.costUsd });
    }
  }

  const instantly = options.skipInstantlyImport ? undefined : await runInstantlyImportTick({
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
  for (const job of jobsToComplete) {
    await db.update(schema.verificationJobs)
      .set({ status: "completed", completedAt: new Date(), costUsd: job.costUsd, lockedAt: null, lockedBy: null, nextAttemptAt: null, lastError: null })
      .where(eq(schema.verificationJobs.id, job.id));
  }
  return {
    jobsClaimed: leased.rows.length,
    emailsVerified: totalEmailsVerified,
    cacheHits: totalCacheHits,
    verificationValid,
    verificationInvalid,
    verificationRisky,
    verificationCatchAll,
    millionVerifierStatus: getMillionVerifierStatus(
      providerName,
      Boolean(env.MILLION_VERIFIER ?? env.MILLIONVERIFIER_API_KEY),
      verificationProviderFailures,
    ),
    ...(instantly ? { instantly } : {}),
  };
}
