import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { evaluateInstantlyContactQuota } from "@/domain/providers/instantly-plan-guard";
import { InstantlyEmailDeliveryProvider } from "@/infrastructure/providers/instantly/provider";
import { getDeliveryEnv } from "@/lib/config/env";
import { getDb } from "@/infrastructure/neon/db";
import {
  acquireInstantlyImportLock,
  claimInstantlyLeadImports,
  deferInstantlyLeadImportsForPlanLimit,
  enqueueInstantlyLeadImport,
  getInstantlyLeadImportCounts,
  isInstantlyImportCircuitOpen,
  releaseInstantlyImportLock,
  tripInstantlyImportCircuitBreaker,
  updateInstantlyLeadImport,
} from "@/infrastructure/neon/repositories/instantly-lead-imports";
import { canEnqueueColdOutreach } from "@/infrastructure/neon/repositories/outreach";
import type { OutreachQueueItem } from "@/domain/outreach/types";
import { evaluateInstantlyLeadEligibility } from "@/services/verification/instantly-lead-eligibility";
import { logEvent } from "@/lib/observability/structured-logger";

const IMPORT_BATCH_SIZE = 50;
const IMPORT_LOCK_MS = 15 * 60_000;
const RETRY_BASE_MINUTES = 15;
const MAX_RETRY_MINUTES = 24 * 60;

interface CandidateRow {
  workspace_id: string;
  account_id: string;
  source_campaign_id: string;
  contact_id: string | null;
  contact_point_id: string;
  normalized_email: string;
  verification_status: string;
  channel_eligibility: string;
  canonical_name: string;
  website_url: string | null;
  normalized_domain: string | null;
  city: string | null;
  country_code: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
}

export interface InstantlyImportTickResult {
  candidatesFound: number;
  leadsQueued: number;
  leadsAdded: number;
  leadsSkipped: number;
  leadsDeferred: number;
  leadsFailed: number;
  providerStatus: "ready" | "missing_configuration" | "unhealthy" | "busy" | "schema_not_ready";
  instantlyLeadImportReady: boolean;
  instantlyTelemetryReady: boolean;
  telemetryWarnings: string[];
  quota: {
    uploadedContacts: number;
    hardLimit: number;
    warning: boolean;
    monthlyEmailsSent: number;
    monthlyEmailLimit: number;
    monthlyWarning: boolean;
  } | null;
  metrics: Record<string, number>;
}

async function listEligibleCandidates(options: {
  providerCampaignId: string;
  createdSince?: Date;
  contactPointIds?: readonly string[];
  backfillAll?: boolean;
  forEnqueue?: boolean;
}): Promise<CandidateRow[]> {
  if (options.contactPointIds?.length === 0) return [];
  const db = getDb();
  const candidateScopeFilter = options.backfillAll
    ? sql``
    : options.contactPointIds && options.createdSince
    ? sql`AND (cp.id IN ${options.contactPointIds} OR cp.created_at >= ${options.createdSince.toISOString()})`
    : options.contactPointIds
      ? sql`AND cp.id IN ${options.contactPointIds}`
      : options.createdSince
        ? sql`AND cp.created_at >= ${options.createdSince.toISOString()}`
        : sql``;
  const existingImportFilter = options.forEnqueue
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM instantly_lead_imports ili
        WHERE ili.workspace_id = a.workspace_id
          AND ili.account_id = a.id
          AND ili.provider_campaign_id = ${options.providerCampaignId}
      )`
    : sql``;
  const result = await db.execute(sql`
    SELECT
      a.workspace_id,
      a.id AS account_id,
      cm.campaign_id AS source_campaign_id,
      COALESCE(cp.contact_id, cm.contact_id) AS contact_id,
      cp.id AS contact_point_id,
      LOWER(TRIM(cp.normalized_value)) AS normalized_email,
      cp.verification_status,
      cp.channel_eligibility,
      a.canonical_name,
      a.website_url,
      a.normalized_domain,
      a.city,
      a.country_code,
      co.first_name,
      co.last_name,
      co.full_name
    FROM campaign_memberships cm
    JOIN campaigns c ON c.id = cm.campaign_id
    JOIN accounts a ON a.id = cm.account_id
    JOIN contact_points cp ON cp.id = cm.selected_contact_point_id
    LEFT JOIN contacts co ON co.id = COALESCE(cp.contact_id, cm.contact_id)
    WHERE c.status = 'active'
      AND cm.stage = 'ready'
      AND cp.type = 'email'
      AND TRIM(cp.normalized_value) <> ''
      AND cp.verification_status = 'valid'
      AND cp.channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
      AND cp.last_contacted_at IS NULL
      AND cm.contacted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM compliance_decisions cd
        WHERE cd.workspace_id = a.workspace_id
          AND cd.campaign_id = cm.campaign_id
          AND cd.account_id = a.id
          AND cd.contact_point_id = cp.id
          AND cd.decision = 'allowed'
          AND cd.superseded_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM suppression_entries se
        WHERE se.workspace_id = a.workspace_id
          AND (se.account_id = a.id OR se.contact_point_id = cp.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM outreach_queue oq
        JOIN campaigns oqc ON oqc.id = oq.campaign_id
        WHERE oq.workspace_id = a.workspace_id
          AND oq.account_id = a.id
          AND oq.channel = 'email'
      )
      AND NOT EXISTS (
        SELECT 1 FROM conversations conv
        WHERE conv.workspace_id = a.workspace_id
          AND conv.account_id = a.id
          AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM meetings m
        JOIN conversations conv ON conv.id = m.conversation_id
        WHERE conv.workspace_id = a.workspace_id
          AND conv.account_id = a.id
      )
      ${candidateScopeFilter}
      ${existingImportFilter}
    ORDER BY cp.priority_score DESC, cp.created_at ASC
    LIMIT 500
  `);
  return result.rows as unknown as CandidateRow[];
}

function createDedupCandidate(row: CandidateRow): OutreachQueueItem {
  return {
    id: "instantly-import-check",
    campaignId: row.source_campaign_id,
    accountId: row.account_id,
    contactId: row.contact_id,
    contactPointId: row.contact_point_id,
    channel: "email",
    priority: 0,
    scheduledFor: null,
    state: "queued",
    deliveryMode: "dry_run",
  };
}

async function enqueueCandidates(
  rows: readonly CandidateRow[],
  providerCampaignId: string,
  now: Date,
): Promise<number> {
  let enqueued = 0;
  for (const row of rows) {
    const coldOutreachAllowed = await canEnqueueColdOutreach(row.workspace_id, createDedupCandidate(row), now);
    const eligibility = evaluateInstantlyLeadEligibility({
      hasEmail: row.normalized_email.length > 0,
      verificationStatus: row.verification_status as CandidateRow["verification_status"] & "valid",
      contactEligibility: "eligible",
      complianceAllowed: true,
      isSuppressed: false,
      hasPriorColdOutreach: !coldOutreachAllowed,
      isInFlight: false,
      alreadyInCampaign: false,
    });
    if (!eligibility.eligible) continue;

    const created = await enqueueInstantlyLeadImport({
      workspaceId: row.workspace_id,
      accountId: row.account_id,
      sourceCampaignId: row.source_campaign_id,
      contactId: row.contact_id,
      contactPointId: row.contact_point_id,
      providerCampaignId,
      normalizedEmail: row.normalized_email,
    });
    if (created) enqueued++;
  }
  return enqueued;
}

function buildLeadVariables(row: CandidateRow): Record<string, string> {
  const fullNameParts = row.full_name?.trim().split(/\s+/) ?? [];
  const firstName = row.first_name?.trim() || fullNameParts[0] || "";
  const lastName = row.last_name?.trim() || fullNameParts.slice(1).join(" ");
  const website = row.website_url?.trim()
    || (row.normalized_domain ? `https://${row.normalized_domain}` : "");
  return {
    first_name: firstName,
    last_name: lastName,
    company_name: row.canonical_name,
    website,
    domain: row.normalized_domain ?? "",
    city: row.city ?? "",
    country: row.country_code ?? "",
  };
}

function retryAt(attemptCount: number, now: Date): Date {
  const minutes = Math.min(MAX_RETRY_MINUTES, RETRY_BASE_MINUTES * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + minutes * 60_000);
}

async function readPipelineMetrics(): Promise<Record<string, number>> {
  const db = getDb();
  const [verification] = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE verification_status IN ('unverified', 'unknown'))::int AS awaiting_verification,
      COUNT(*) FILTER (WHERE verification_status = 'valid')::int AS verification_valid,
      COUNT(*) FILTER (WHERE verification_status IN ('catch_all', 'risky', 'invalid', 'disposable', 'bounced'))::int AS verification_blocked
    FROM contact_points
    WHERE type = 'email'
  `).then((result) => result.rows as Array<Record<string, number>>);
  const imports = await getInstantlyLeadImportCounts();
  const eligible = (imports.eligible ?? 0) + (imports.instantly_queued ?? 0) + (imports.instantly_added ?? 0)
    + (imports.skipped_existing ?? 0) + (imports.failed ?? 0) + (imports.deferred ?? 0)
    + (imports.deferred_due_to_plan_limit ?? 0);
  return {
    awaiting_verification: Number(verification?.awaiting_verification ?? 0),
    verification_valid: Number(verification?.verification_valid ?? 0),
    verification_blocked: Number(verification?.verification_blocked ?? 0),
    eligible,
    instantly_pending: (imports.eligible ?? 0) + (imports.instantly_queued ?? 0) + (imports.deferred ?? 0)
      + (imports.deferred_due_to_plan_limit ?? 0),
    instantly_added: imports.instantly_added ?? 0,
    instantly_failed: imports.failed ?? 0,
  };
}

export async function runInstantlyImportTick(options: {
  createdSince?: Date;
  contactPointIds?: readonly string[];
  backfillAll?: boolean;
  processQueueOnly?: boolean;
  now?: Date;
} = {}): Promise<InstantlyImportTickResult> {
  const now = options.now ?? new Date();
  const env = getDeliveryEnv();
  const db = getDb();
  const schemaStatus = await db.execute(sql`
    SELECT
      to_regclass('public.instantly_lead_imports') IS NOT NULL AS imports_ready,
      to_regclass('public.instantly_import_locks') IS NOT NULL AS locks_ready
  `);
  const [schemaRow] = schemaStatus.rows as Array<{ imports_ready: boolean; locks_ready: boolean }>;
  if (!schemaRow?.imports_ready || !schemaRow.locks_ready) {
    return {
      candidatesFound: 0,
      leadsQueued: 0,
      leadsAdded: 0,
      leadsSkipped: 0,
      leadsDeferred: 0,
      leadsFailed: 0,
      providerStatus: "schema_not_ready",
      instantlyLeadImportReady: false,
      instantlyTelemetryReady: false,
      telemetryWarnings: [],
      quota: null,
      metrics: {},
    };
  }
  const initialMetrics = await readPipelineMetrics();
  const result: InstantlyImportTickResult = {
    candidatesFound: 0,
    leadsQueued: 0,
    leadsAdded: 0,
    leadsSkipped: 0,
    leadsDeferred: 0,
    leadsFailed: 0,
    providerStatus: "missing_configuration",
    instantlyLeadImportReady: false,
    instantlyTelemetryReady: false,
    telemetryWarnings: [],
    quota: null,
    metrics: initialMetrics,
  };

  if (options.contactPointIds?.length === 0) {
    result.providerStatus = "ready";
    return result;
  }

  if (!options.processQueueOnly) {
    const candidates = await listEligibleCandidates({
      providerCampaignId: env.INSTANTLY_CAMPAIGN_ID,
      createdSince: options.createdSince,
      contactPointIds: options.contactPointIds,
      backfillAll: options.backfillAll,
      forEnqueue: true,
    });
    result.candidatesFound = candidates.length;
    result.leadsQueued = await enqueueCandidates(candidates, env.INSTANTLY_CAMPAIGN_ID, now);
  }
  result.metrics = await readPipelineMetrics();
  if (env.EMAIL_DELIVERY_PROVIDER !== "instantly" || !env.INSTANTLY_API_KEY) return result;

  const lockToken = randomUUID();
  const lockAcquired = await acquireInstantlyImportLock(
    env.INSTANTLY_CAMPAIGN_ID,
    lockToken,
    now,
    new Date(now.getTime() + IMPORT_LOCK_MS),
  );
  if (!lockAcquired) {
    result.providerStatus = await isInstantlyImportCircuitOpen(env.INSTANTLY_CAMPAIGN_ID) ? "unhealthy" : "busy";
    result.metrics = await readPipelineMetrics();
    return result;
  }

  let preserveLock = false;
  try {
    const provider = new InstantlyEmailDeliveryProvider({ apiKey: env.INSTANTLY_API_KEY });
    const [planResult, monthlyResult] = await Promise.allSettled([
      provider.getPlanUsage(),
      provider.getMonthlyEmailUsage(now),
    ]);
    const planUsage = planResult.status === "fulfilled" ? planResult.value : null;
    const monthlyUsage = monthlyResult.status === "fulfilled" ? monthlyResult.value : null;
    result.instantlyTelemetryReady = Boolean(planUsage && monthlyUsage);
    const unavailableTelemetry = [
      ...(planResult.status === "rejected" ? [{ endpoint: "workspace-billing/plan-details", error: planResult.reason }] : []),
      ...(monthlyResult.status === "rejected" ? [{ endpoint: "campaigns/analytics", error: monthlyResult.reason }] : []),
    ];
    for (const unavailable of unavailableTelemetry) {
      const error = unavailable.error;
      const apiError = error instanceof Error && error.name === "InstantlyApiError" && "details" in error
        ? (error as Error & { details: { requestId?: string; httpStatus?: number | null; providerErrorCode?: string | null } }).details
        : null;
      result.telemetryWarnings.push(`${unavailable.endpoint} unavailable`);
      logEvent("warn", "Instantly telemetry unavailable; applying local limits", {
        correlationId: apiError?.requestId ?? randomUUID(),
        provider: "instantly",
        endpointCategory: unavailable.endpoint,
        httpStatus: apiError?.httpStatus ?? null,
        providerErrorCode: apiError?.providerErrorCode ?? (error instanceof Error ? error.name : "REQUEST_FAILED"),
      });
    }

    const localUploadedContacts = result.metrics.instantly_added ?? 0;
    const localMonthlyUsage = monthlyUsage
      ? monthlyUsage.emailsSent
      : await db.execute(sql`
          SELECT COUNT(*)::int AS count
          FROM instantly_lead_imports
          WHERE provider_campaign_id = ${env.INSTANTLY_CAMPAIGN_ID}
            AND status = 'instantly_added'
            AND uploaded_at >= ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()}
        `).then((query) => Number((query.rows[0] as { count?: number } | undefined)?.count ?? 0));
    let uploadedContacts = planUsage?.currentLeadCount ?? localUploadedContacts;
    const providerLimit = planUsage?.totalLeadLimit ?? env.INSTANTLY_MAX_UPLOADED_CONTACTS;
    const quotaDecision = evaluateInstantlyContactQuota({
      uploadedContacts,
      providerLimit,
      configuredHardLimit: env.INSTANTLY_MAX_UPLOADED_CONTACTS,
      warningThreshold: env.INSTANTLY_CONTACT_USAGE_WARNING_THRESHOLD,
    });
    result.quota = {
      uploadedContacts,
      hardLimit: quotaDecision.hardLimit,
      warning: quotaDecision.warning,
      monthlyEmailsSent: localMonthlyUsage,
      monthlyEmailLimit: env.INSTANTLY_MAX_MONTHLY_EMAILS,
      monthlyWarning: localMonthlyUsage >= env.INSTANTLY_MONTHLY_EMAIL_WARNING_THRESHOLD,
    };
    result.providerStatus = "ready";
    if (!quotaDecision.allowed || localMonthlyUsage >= env.INSTANTLY_MAX_MONTHLY_EMAILS) {
      result.leadsDeferred = await deferInstantlyLeadImportsForPlanLimit(env.INSTANTLY_CAMPAIGN_ID, now);
      result.metrics = await readPipelineMetrics();
      return result;
    }

    const slots = Math.min(IMPORT_BATCH_SIZE, quotaDecision.remaining);
    const jobs = await claimInstantlyLeadImports(Math.min(IMPORT_BATCH_SIZE, slots), now);
    const currentCandidates = jobs.length > 0 ? await listEligibleCandidates({
        providerCampaignId: env.INSTANTLY_CAMPAIGN_ID,
        contactPointIds: jobs.map((job) => String(job.contact_point_id)),
      }) : [];
    const candidateByContactPoint = new Map(currentCandidates.map((candidate) => [candidate.contact_point_id, candidate]));
    const importableJobs: Array<{ job: Record<string, unknown>; candidate: CandidateRow }> = [];
    for (const job of jobs) {
      const jobId = String(job.id);
      const candidate = candidateByContactPoint.get(String(job.contact_point_id));
      if (!candidate || candidate.account_id !== String(job.account_id)) {
        await updateInstantlyLeadImport(jobId, {
          status: "deferred",
          now,
          nextAttemptAt: new Date(now.getTime() + 24 * 60 * 60_000),
          lastError: "Eligibility changed before campaign import.",
        });
        result.leadsDeferred++;
        continue;
      }
      importableJobs.push({ job, candidate });
    }

    if (importableJobs.length > 0) {
      try {
        const batch = await provider.addLeads(importableJobs.map(({ candidate }) => ({
          providerCampaignId: env.INSTANTLY_CAMPAIGN_ID,
          email: candidate.normalized_email,
          customVariables: buildLeadVariables(candidate),
          skipIfExisting: true,
          allowCampaignImportInDryRun: true,
        })));
        result.instantlyLeadImportReady = true;
        for (const outcome of batch.outcomes) {
          const { job, candidate } = importableJobs[outcome.index]!;
          const jobId = String(job.id);
          if (outcome.status === "added") {
            await updateInstantlyLeadImport(jobId, {
            status: "instantly_added",
            now,
            providerLeadId: outcome.providerLeadId,
          });
          uploadedContacts++;
          result.leadsAdded++;
          } else if (outcome.status === "skipped_existing") {
            await updateInstantlyLeadImport(jobId, {
            status: "skipped_existing",
            now,
            providerLeadId: outcome.providerLeadId,
          });
          result.leadsSkipped++;
          } else {
            await updateInstantlyLeadImport(jobId, {
              status: "failed",
              now,
              nextAttemptAt: retryAt(Number(job.attempt_count ?? 1), now),
              lastError: outcome.diagnostic ?? "Instantly leads/add rejected this lead.",
            });
            result.leadsFailed++;
          }
          result.quota.uploadedContacts = uploadedContacts;
          result.quota.warning = uploadedContacts >= env.INSTANTLY_CONTACT_USAGE_WARNING_THRESHOLD;
        }
      } catch (error) {
        logEvent("error", "Instantly bulk import batch failed", {
          correlationId: randomUUID(),
          provider: "instantly",
          endpointCategory: "leads/add",
          httpStatus: error instanceof Error && error.name === "InstantlyApiError" && "details" in error
            ? (error as Error & { details: { httpStatus: number | null } }).details.httpStatus
            : null,
          providerMessage: error instanceof Error ? error.message : "Instantly bulk import failed.",
        });
        const apiErrorDetails = error instanceof Error && error.name === "InstantlyApiError" && "details" in error
          ? (error as Error & { details: { httpStatus: number | null; requestId?: string } }).details
          : null;
        if (apiErrorDetails?.httpStatus === 401 || apiErrorDetails?.httpStatus === 403) {
          result.providerStatus = "unhealthy";
          preserveLock = true;
          await tripInstantlyImportCircuitBreaker(
            env.INSTANTLY_CAMPAIGN_ID,
            lockToken,
            apiErrorDetails.requestId ?? randomUUID(),
          );
        }
        for (const { job } of importableJobs) {
          const attempts = Number(job.attempt_count ?? 1);
          const exhausted = attempts >= Number(job.max_attempts ?? 8);
          await updateInstantlyLeadImport(String(job.id), {
            status: "failed",
            now,
            nextAttemptAt: exhausted ? null : retryAt(attempts, now),
            lastError: error instanceof Error ? error.message : "Instantly import failed.",
          });
          result.leadsFailed++;
        }
      }
    }
  } finally {
    if (!preserveLock) await releaseInstantlyImportLock(env.INSTANTLY_CAMPAIGN_ID, lockToken);
  }

  result.metrics = await readPipelineMetrics();
  return result;
}