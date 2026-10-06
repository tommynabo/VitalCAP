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
import { actualPriorColdOutreachSql, hasActualPriorColdOutreach } from "@/infrastructure/neon/repositories/actual-outreach";
import { evaluateInstantlyLeadEligibility } from "@/services/verification/instantly-lead-eligibility";
import { logEvent } from "@/lib/observability/structured-logger";
import { emailChannelEligibilitySql, isEmailChannelEligible } from "@/services/compliance/email-channel-policy";
import type { ChannelEligibilityStatus } from "@/domain/contacts/types";

const IMPORT_BATCH_SIZE = 50;
const MAX_INSTANTLY_WRITE_CONCURRENCY = 2;
const TARGET_READBACK_ATTEMPTS = 4;
const TARGET_READBACK_RETRY_DELAY_MS = 3_333;
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
  channel_eligibility: ChannelEligibilityStatus;
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
  leadsAttempted: number;
  leadsAdded: number;
  leadsSkipped: number;
  leadsExistingTarget?: number;
  leadsNeedsCampaignMove?: number;
  leadsNeedsReconciliation?: number;
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
    JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
    JOIN contact_points cp ON cp.id = cm.selected_contact_point_id
      AND cp.account_id = a.id AND cp.workspace_id = a.workspace_id
    LEFT JOIN contacts co ON co.id = COALESCE(cp.contact_id, cm.contact_id)
      AND co.workspace_id = a.workspace_id
    WHERE c.status = 'active'
      AND cm.stage = 'ready'
      AND cp.type = 'email'
      AND TRIM(cp.normalized_value) <> ''
      AND cp.verification_status = 'valid'
      AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
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
      AND NOT ${actualPriorColdOutreachSql({
        workspaceId: "a.workspace_id",
        accountId: "a.id",
        contactPointId: "cp.id",
        normalizedEmail: "cp.normalized_value",
      })}
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

async function enqueueCandidates(
  rows: readonly CandidateRow[],
  providerCampaignId: string,
): Promise<number> {
  let enqueued = 0;
  for (const row of rows) {
    if (!isEmailChannelEligible(row.channel_eligibility)) continue;
    const hasPriorOutreach = await hasActualPriorColdOutreach({
      workspaceId: row.workspace_id,
      accountId: row.account_id,
      contactPointId: row.contact_point_id,
      normalizedEmail: row.normalized_email,
    });
    const eligibility = evaluateInstantlyLeadEligibility({
      hasEmail: row.normalized_email.length > 0,
      verificationStatus: row.verification_status as CandidateRow["verification_status"] & "valid",
      contactEligibility: "eligible",
      complianceAllowed: true,
      isSuppressed: false,
      hasPriorColdOutreach: hasPriorOutreach,
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

interface DirectImportOutcome {
  index: number;
  status: "added" | "skipped_existing" | "reconciliation_required" | "failed" | "deferred";
  providerLeadId: string | null;
  diagnostic: string | null;
  authFailure: boolean;
  requestId: string | null;
}

function instantlyHttpErrorDetails(error: unknown): { httpStatus: number | null; requestId?: string } | null {
  if (!(error instanceof Error) || error.name !== "InstantlyApiError" || !("details" in error)) return null;
  const details = (error as Error & { details?: { httpStatus?: number | null; requestId?: string } }).details;
  if (!details) return null;
  return { httpStatus: details.httpStatus ?? null, requestId: details.requestId };
}

async function findLeadInCampaignWithRetry(
  provider: InstantlyEmailDeliveryProvider,
  providerCampaignId: string,
  email: string,
): Promise<{ providerLeadId: string | null; authFailure: boolean; requestId: string | null }> {
  for (let attempt = 1; attempt <= TARGET_READBACK_ATTEMPTS; attempt++) {
    try {
      const providerLeadId = await provider.findLeadInCampaign(providerCampaignId, email);
      if (providerLeadId) return { providerLeadId, authFailure: false, requestId: null };
    } catch (error) {
      const details = instantlyHttpErrorDetails(error);
      if (details?.httpStatus === 401 || details?.httpStatus === 403) {
        return { providerLeadId: null, authFailure: true, requestId: details.requestId ?? null };
      }
    }
    if (attempt < TARGET_READBACK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, TARGET_READBACK_RETRY_DELAY_MS));
    }
  }
  return { providerLeadId: null, authFailure: false, requestId: null };
}

async function importSingleLead(
  provider: InstantlyEmailDeliveryProvider,
  providerCampaignId: string,
  candidate: CandidateRow,
  index: number,
): Promise<DirectImportOutcome> {
  let single;
  try {
    single = await provider.addLeadToCampaign({
      providerCampaignId,
      email: candidate.normalized_email,
      customVariables: buildLeadVariables(candidate),
      skipIfInWorkspace: false,
      skipIfInCampaign: true,
      allowCampaignImportInDryRun: true,
    });
  } catch (error) {
    const details = instantlyHttpErrorDetails(error);
    return {
      index,
      status: "failed",
      providerLeadId: null,
      diagnostic: error instanceof Error ? error.message : "Instantly single-lead request failed.",
      authFailure: details?.httpStatus === 401 || details?.httpStatus === 403,
      requestId: details?.requestId ?? null,
    };
  }

  const authFailure = single.httpStatus === 401 || single.httpStatus === 403;
  if (single.status === "failed") {
    return {
      index,
      status: "failed",
      providerLeadId: single.providerLeadId,
      diagnostic: single.sanitizedProviderMessage ?? "Instantly rejected the single-lead request.",
      authFailure,
      requestId: single.requestId,
    };
  }

  const readback = await findLeadInCampaignWithRetry(provider, providerCampaignId, candidate.normalized_email);
  if (!readback.providerLeadId) {
    return {
      index,
      status: "reconciliation_required",
      providerLeadId: single.providerLeadId,
      diagnostic: readback.authFailure
        ? "Instantly read-back stopped after an authorization error."
        : "Instantly accepted the lead, but target-campaign read-back did not confirm membership after retries.",
      authFailure: authFailure || readback.authFailure,
      requestId: single.requestId ?? readback.requestId,
    };
  }

  return {
    index,
    status: single.status === "added" ? "added" : "skipped_existing",
    providerLeadId: readback.providerLeadId,
    diagnostic: null,
    authFailure,
    requestId: single.requestId,
  };
}

async function importLeadsDirect(
  provider: InstantlyEmailDeliveryProvider,
  providerCampaignId: string,
  candidates: readonly CandidateRow[],
  onAuthorizationFailure: (requestId: string | null) => Promise<void>,
): Promise<{ outcomes: DirectImportOutcome[]; attempted: number }> {
  const outcomes: Array<DirectImportOutcome | undefined> = Array.from({ length: candidates.length });
  let nextIndex = 0;
  let attempted = 0;
  let stopScheduling = false;
  let reconciliationFailures = 0;
  const worker = async () => {
    while (!stopScheduling) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      attempted++;
      const outcome = await importSingleLead(provider, providerCampaignId, candidates[index]!, index);
      outcomes[index] = outcome;
      if (outcome.authFailure) {
        stopScheduling = true;
        await onAuthorizationFailure(outcome.requestId);
      } else if (outcome.status === "reconciliation_required") {
        reconciliationFailures++;
        if (reconciliationFailures >= 2) stopScheduling = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_INSTANTLY_WRITE_CONCURRENCY, candidates.length) }, () => worker()),
  );
  return {
    attempted,
    outcomes: outcomes.map((outcome, index) => outcome ?? {
      index,
      status: "deferred",
      providerLeadId: null,
      diagnostic: "Import paused after a provider or repeated read-back safety stop.",
      authFailure: false,
      requestId: null,
    }),
  };
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
    + (imports.deferred_due_to_plan_limit ?? 0) + (imports.needs_campaign_move ?? 0)
    + (imports.reconciliation_required ?? 0);
  return {
    awaiting_verification: Number(verification?.awaiting_verification ?? 0),
    verification_valid: Number(verification?.verification_valid ?? 0),
    verification_blocked: Number(verification?.verification_blocked ?? 0),
    eligible,
    instantly_pending: (imports.eligible ?? 0) + (imports.instantly_queued ?? 0) + (imports.deferred ?? 0)
      + (imports.deferred_due_to_plan_limit ?? 0),
    instantly_added: imports.instantly_added ?? 0,
    instantly_failed: imports.failed ?? 0,
    instantly_needs_campaign_move: imports.needs_campaign_move ?? 0,
    instantly_needs_reconciliation: imports.reconciliation_required ?? 0,
  };
}

export async function runInstantlyImportTick(options: {
  createdSince?: Date;
  contactPointIds?: readonly string[];
  backfillAll?: boolean;
  processQueueOnly?: boolean;
  maxJobs?: number;
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
      leadsAttempted: 0,
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
    leadsAttempted: 0,
    leadsAdded: 0,
    leadsSkipped: 0,
    leadsExistingTarget: 0,
    leadsNeedsCampaignMove: 0,
    leadsNeedsReconciliation: 0,
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
    result.leadsQueued = await enqueueCandidates(candidates, env.INSTANTLY_CAMPAIGN_ID);
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

    const requestedBatchSize = options.maxJobs === undefined
      ? IMPORT_BATCH_SIZE
      : Math.max(1, Math.floor(options.maxJobs));
    const slots = Math.min(IMPORT_BATCH_SIZE, requestedBatchSize, quotaDecision.remaining);
    const jobs = await claimInstantlyLeadImports(slots, now);
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
        const direct = await importLeadsDirect(
          provider,
          env.INSTANTLY_CAMPAIGN_ID,
          importableJobs.map(({ candidate }) => candidate),
          async (requestId) => {
            result.providerStatus = "unhealthy";
            preserveLock = true;
            await tripInstantlyImportCircuitBreaker(
              env.INSTANTLY_CAMPAIGN_ID,
              lockToken,
              requestId ?? randomUUID(),
            );
          },
        );
        const outcomes = direct.outcomes;
        result.leadsAttempted += direct.attempted;
        result.instantlyLeadImportReady = outcomes.some((outcome) =>
          outcome.status === "added"
          || outcome.status === "skipped_existing"
          || outcome.status === "reconciliation_required",
        );
        for (const outcome of outcomes) {
          const { job } = importableJobs[outcome.index]!;
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
            result.leadsExistingTarget = (result.leadsExistingTarget ?? 0) + 1;
          } else if (outcome.status === "reconciliation_required") {
            await updateInstantlyLeadImport(jobId, {
              status: "reconciliation_required",
              now,
              lastError: outcome.diagnostic ?? "Instantly did not provide an unambiguous per-lead result.",
            });
            result.leadsNeedsReconciliation = (result.leadsNeedsReconciliation ?? 0) + 1;
          } else if (outcome.status === "deferred") {
            await updateInstantlyLeadImport(jobId, {
              status: "deferred",
              now,
              nextAttemptAt: now,
              lastError: outcome.diagnostic,
              decrementAttemptCount: true,
            });
            result.leadsDeferred++;
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
        const details = instantlyHttpErrorDetails(error);
        logEvent("error", "Instantly direct import failed", {
          correlationId: details?.requestId ?? randomUUID(),
          provider: "instantly",
          endpointCategory: "leads",
          httpStatus: details?.httpStatus ?? null,
          providerMessage: error instanceof Error ? error.message : "Instantly direct import failed.",
        });
        throw error;
      }
    }
  } finally {
    if (!preserveLock) await releaseInstantlyImportLock(env.INSTANTLY_CAMPAIGN_ID, lockToken);
  }

  result.metrics = await readPipelineMetrics();
  return result;
}