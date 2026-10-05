import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getNeonSql } from "@/infrastructure/neon/db";
import { getDatabaseEnv, getDeliveryEnv, getVerificationEnv } from "@/lib/config/env";
import { logEvent } from "@/lib/observability/structured-logger";
import { ACTUAL_PRIOR_COLD_OUTREACH_STATES } from "@/services/deduplication/outreach-dedup";
import { isAuthorizedCronRequest, unauthorizedCronResponse } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

const requiredMigrations = [
  "0013_global_deduplication.sql",
  "0014_setter_runtime.sql",
  "0015_email_verification_pipeline.sql",
  "0016_email_verification_cache_version.sql",
] as const;
const requiredMigrationsThrough0017 = [...requiredMigrations, "0017_instantly_lead_imports.sql"] as const;
const requiredInstantlyIndexes = [
  "uq_instantly_import_identity",
  "uq_instantly_import_idempotency",
  "uq_instantly_import_email",
  "uq_instantly_import_active_account",
  "idx_instantly_import_dispatch",
  "idx_instantly_import_workspace_status",
] as const;
const instantlyCampaignId = "055534c5-c3e3-414f-b140-f4770b293c00";
const instantlyApiBaseUrl = "https://api.instantly.ai/api/v2";

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "REQUEST_TIMEOUT";
  return "REQUEST_FAILED";
}

async function readDatabaseState() {
  const databaseUrlAvailable = Boolean(
    getDatabaseEnv().DATABASE_URL?.trim() || getDatabaseEnv().DATABASE_URL_UNPOOLED?.trim(),
  );
  if (!databaseUrlAvailable) {
    return {
      configured: false,
      healthy: false,
      through0016: false,
      through0017: false,
      migration0017Applied: false,
      instantlyTablesExist: false,
      requiredIndexesPresent: false,
      errorCode: "DATABASE_URL_MISSING",
    };
  }

  try {
    const sql = getNeonSql();
    const [state] = await sql`
      SELECT
        to_regclass('public.vitalcap_migrations') AS migration_ledger,
        to_regclass('public.instantly_lead_imports') AS instantly_lead_imports,
        to_regclass('public.instantly_import_locks') AS instantly_import_locks
    `;
    const migrationLedgerExists = Boolean(state?.migration_ledger);
    const leadImportsExist = Boolean(state?.instantly_lead_imports);
    const locksExist = Boolean(state?.instantly_import_locks);
    const migrationRows = migrationLedgerExists
      ? await sql`
          SELECT filename
          FROM public.vitalcap_migrations
          WHERE filename IN (
            '0013_global_deduplication.sql',
            '0014_setter_runtime.sql',
            '0015_email_verification_pipeline.sql',
            '0016_email_verification_cache_version.sql',
            '0017_instantly_lead_imports.sql'
          )
        `
      : [];
    const applied = new Set(migrationRows.map((row) => String(row.filename)));
    const tablesExist = leadImportsExist && locksExist;
    const indexRows = tablesExist
      ? await sql`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'instantly_lead_imports'
            AND indexname IN (
              'uq_instantly_import_identity',
              'uq_instantly_import_idempotency',
              'uq_instantly_import_email',
              'uq_instantly_import_active_account',
              'idx_instantly_import_dispatch',
              'idx_instantly_import_workspace_status'
            )
        `
      : [];
    const indexes = new Set(indexRows.map((row) => String(row.indexname)));

    return {
      configured: true,
      healthy: true,
      through0016: migrationLedgerExists && requiredMigrations.every((filename) => applied.has(filename)),
      through0017: migrationLedgerExists && requiredMigrationsThrough0017.every((filename) => applied.has(filename)),
      migration0017Applied: applied.has("0017_instantly_lead_imports.sql"),
      instantlyTablesExist: tablesExist,
      requiredIndexesPresent: tablesExist && requiredInstantlyIndexes.every((index) => indexes.has(index)),
      missingMigrations: requiredMigrationsThrough0017.filter((filename) => !applied.has(filename)),
      errorCode: migrationLedgerExists ? null : "MIGRATION_LEDGER_MISSING",
    };
  } catch {
    return {
      configured: true,
      healthy: false,
      through0016: false,
      through0017: false,
      migration0017Applied: false,
      instantlyTablesExist: false,
      requiredIndexesPresent: false,
      errorCode: "DATABASE_PREFLIGHT_FAILED",
    };
  }
}

async function readHistoricalFunnel(): Promise<Record<string, number> | null> {
  try {
    const sql = getNeonSql();
    const [row] = await sql`
      WITH scoped_raw AS (
        SELECT rc.id AS raw_candidate_id, c.id AS campaign_id, c.workspace_id, rc.account_id
        FROM raw_candidates rc
        JOIN campaigns c ON c.id = rc.campaign_id
        JOIN accounts a ON a.id = rc.account_id AND a.workspace_id = c.workspace_id
        WHERE c.status = 'active'
          AND c.autopilot_enabled = true
      ), scope AS (
        SELECT DISTINCT campaign_id, workspace_id, account_id
        FROM scoped_raw
      ), points AS (
        SELECT
          s.campaign_id,
          s.workspace_id,
          s.account_id,
          cm.id AS membership_id,
          cm.stage,
          cm.selected_contact_point_id,
          cp.id AS contact_point_id,
          cp.verification_status,
          cp.channel_eligibility,
          cp.last_contacted_at,
          cd.decision,
          ev.status AS cached_verification_status,
          (se.id IS NOT NULL) AS suppressed,
          (EXISTS (
            SELECT 1 FROM outreach_queue oq
            WHERE oq.workspace_id = s.workspace_id AND oq.account_id = s.account_id AND oq.channel = 'email'
              AND ((oq.delivery_mode = 'live' AND oq.state = ANY(${[...ACTUAL_PRIOR_COLD_OUTREACH_STATES]}::text[]))
                OR EXISTS (
                  SELECT 1 FROM outreach_events oe
                  WHERE oe.outreach_queue_item_id = oq.id
                    AND oe.state = ANY(${[...ACTUAL_PRIOR_COLD_OUTREACH_STATES]}::text[])
                ))
          ) OR cp.last_contacted_at IS NOT NULL OR cm.contacted_at IS NOT NULL) AS prior_outreach,
          (conv.id IS NOT NULL OR meeting.id IS NOT NULL) AS active_conversation
        FROM scope s
        LEFT JOIN campaign_memberships cm ON cm.campaign_id = s.campaign_id AND cm.account_id = s.account_id
        LEFT JOIN contact_points cp ON cp.account_id = s.account_id AND cp.type = 'email'
        LEFT JOIN compliance_decisions cd ON cd.campaign_id = s.campaign_id
          AND cd.account_id = s.account_id
          AND cd.contact_point_id = cp.id
          AND cd.superseded_at IS NULL
        LEFT JOIN email_verifications ev ON ev.workspace_id = s.workspace_id
          AND ev.normalized_email = LOWER(TRIM(cp.normalized_value))
          AND ev.provider = 'millionverifier'
          AND ev.expires_at > NOW()
        LEFT JOIN suppression_entries se ON se.workspace_id = s.workspace_id
          AND (se.account_id = s.account_id OR se.contact_point_id = cp.id)
        LEFT JOIN conversations conv ON conv.workspace_id = s.workspace_id
          AND conv.account_id = s.account_id
          AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
        LEFT JOIN meetings meeting ON meeting.conversation_id = conv.id
      )
      SELECT
        (SELECT COUNT(DISTINCT raw_candidate_id) FROM scoped_raw)::int AS raw_autopilot_candidates,
        (SELECT COUNT(DISTINCT account_id) FROM scope)::int AS canonical_accounts,
        COUNT(DISTINCT account_id) FILTER (WHERE contact_point_id IS NOT NULL)::int AS accounts_with_email,
        COUNT(DISTINCT membership_id)::int AS campaign_memberships,
        COUNT(DISTINCT account_id) FILTER (WHERE stage IN ('qualified', 'contact_selected'))::int AS qualified,
        COUNT(DISTINCT account_id) FILTER (WHERE stage = 'ready')::int AS ready,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE contact_point_id = selected_contact_point_id)::int AS selected_email,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE verification_status IN ('unverified', 'unknown'))::int AS unverified,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE cached_verification_status = 'valid')::int AS valid_cached,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE cached_verification_status IN ('invalid', 'risky', 'catch_all', 'disposable'))::int AS invalid_cached,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE contact_point_id = selected_contact_point_id AND decision IS NULL)::int AS missing_compliance,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE decision = 'allowed')::int AS compliance_allowed,
        COUNT(DISTINCT contact_point_id) FILTER (WHERE suppressed)::int AS suppressed,
        COUNT(DISTINCT account_id) FILTER (WHERE prior_outreach)::int AS prior_outreach,
        COUNT(DISTINCT account_id) FILTER (WHERE active_conversation)::int AS active_conversation,
        COUNT(DISTINCT contact_point_id) FILTER (
          WHERE verification_status IN ('unverified', 'unknown')
            AND channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
            AND NOT suppressed AND NOT prior_outreach AND NOT active_conversation
        )::int AS eligible_for_verification,
        COUNT(DISTINCT contact_point_id) FILTER (
          WHERE contact_point_id = selected_contact_point_id
            AND verification_status = 'valid'
            AND channel_eligibility IN ('eligible_email', 'consented_email', 'prior_relationship')
            AND decision = 'allowed'
            AND NOT suppressed AND NOT prior_outreach AND NOT active_conversation
        )::int AS eligible_for_instantly
      FROM points
    `;
    if (!row) return null;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
  } catch {
    return null;
  }
}

async function readMillionVerifierState() {
  const env = getVerificationEnv();
  const apiKey = (env.MILLION_VERIFIER ?? env.MILLIONVERIFIER_API_KEY)?.trim();
  const configured = env.EMAIL_VERIFICATION_PROVIDER === "millionverifier" && Boolean(apiKey);
  if (!configured || !apiKey) {
    return {
      configured,
      provider: env.EMAIL_VERIFICATION_PROVIDER,
      healthy: false,
      creditsAvailable: false,
      creditsRemaining: null,
      httpStatus: null,
      errorCode: "MILLIONVERIFIER_CONFIGURATION_MISSING",
    };
  }

  const url = new URL("https://api.millionverifier.com/api/v3/credits");
  url.searchParams.set("api", apiKey);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    let data: { credits?: unknown; error?: unknown } = {};
    try {
      data = await response.json() as typeof data;
    } catch {
      // A non-JSON response is reported as a sanitized provider error below.
    }
    const credits = typeof data.credits === "number" && Number.isFinite(data.credits) ? data.credits : null;
    const providerError = typeof data.error === "string" && data.error.length > 0;
    const healthy = response.ok && credits !== null && !providerError;

    return {
      configured,
      provider: env.EMAIL_VERIFICATION_PROVIDER,
      healthy,
      creditsAvailable: credits !== null && credits > 0,
      creditsRemaining: credits,
      httpStatus: response.status,
      errorCode: healthy ? null : response.status === 401 || response.status === 403 ? "PROVIDER_UNAUTHORIZED" : providerError ? "PROVIDER_REPORTED_ERROR" : "INVALID_CREDITS_RESPONSE",
    };
  } catch (error) {
    return {
      configured,
      provider: env.EMAIL_VERIFICATION_PROVIDER,
      healthy: false,
      creditsAvailable: false,
      creditsRemaining: null,
      httpStatus: null,
      errorCode: safeErrorCode(error),
    };
  }
}

async function readRecentLeadWriteProof(providerCampaignId: string): Promise<{
  occurredAt: string;
  providerCampaignId: string;
} | null> {
  try {
    const sql = getNeonSql();
    const [row] = await sql`
      SELECT uploaded_at, provider_campaign_id
      FROM public.instantly_lead_imports
      WHERE provider_campaign_id = ${providerCampaignId}
        AND status = 'instantly_added'
        AND uploaded_at >= NOW() - INTERVAL '7 days'
        AND provider_lead_id IS NOT NULL
        AND provider_lead_id NOT LIKE 'dryrun%'
      ORDER BY uploaded_at DESC
      LIMIT 1
    `;
    const occurredAt = row?.uploaded_at instanceof Date
      ? row.uploaded_at.toISOString()
      : typeof row?.uploaded_at === "string" ? row.uploaded_at : null;
    if (!occurredAt || !row?.provider_campaign_id) return null;
    return { occurredAt, providerCampaignId: String(row.provider_campaign_id) };
  } catch {
    return null;
  }
}

async function readInstantlyState() {
  const env = getDeliveryEnv();
  const apiKey = env.INSTANTLY_API_KEY?.trim();
  const campaignId = env.INSTANTLY_CAMPAIGN_ID.trim();
  const configured = env.EMAIL_DELIVERY_PROVIDER === "instantly" && Boolean(apiKey);
  const limits = {
    contactLimit: Math.min(env.INSTANTLY_MAX_UPLOADED_CONTACTS, 1000),
    contactWarningThreshold: Math.min(env.INSTANTLY_CONTACT_USAGE_WARNING_THRESHOLD, 900),
    monthlyEmailLimit: Math.min(env.INSTANTLY_MAX_MONTHLY_EMAILS, 5000),
    monthlyEmailWarningThreshold: Math.min(env.INSTANTLY_MONTHLY_EMAIL_WARNING_THRESHOLD, 4500),
  };
  if (!configured || !apiKey) {
    return {
      configured,
      configurationReady: false,
      campaignRead: "FAIL",
      leadsWrite: "NOT_TESTED",
      writeProof: "NOT_TESTED",
      instantlyLeadImportReady: false,
      lastSuccessfulLeadWriteAt: null,
      lastSuccessfulLeadWriteCampaignId: null,
      lastSuccessfulLeadWriteRequestIdSanitized: null,
      telemetryReady: false,
      campaignAccessible: false,
      campaignId,
      auth: { leadsWrite: "NOT_TESTED", campaignRead: "FAIL", analyticsRead: "OPTIONAL_FAIL", billingRead: "OPTIONAL_FAIL" },
      httpStatus: { plan: null, analytics: null, campaign: null },
      planUsage: {
        uploadedContacts: null,
        providerContactLimit: null,
        contactLimit: limits.contactLimit,
        monthlyEmailsSent: null,
        monthlyEmailLimit: limits.monthlyEmailLimit,
        contactWarningThreshold: limits.contactWarningThreshold,
        monthlyEmailWarningThreshold: limits.monthlyEmailWarningThreshold,
      },
      errorCode: "INSTANTLY_CONFIGURATION_MISSING",
      limits,
    };
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const analyticsUrl = new URL(`${instantlyApiBaseUrl}/campaigns/analytics`);
  analyticsUrl.searchParams.set("start_date", monthStart.toISOString());
  analyticsUrl.searchParams.set("end_date", now.toISOString());
  analyticsUrl.searchParams.set("exclude_total_leads_count", "true");
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function readEndpoint(endpointCategory: string, url: string | URL) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" });
      const data = await response.json().catch(() => null) as Record<string, unknown> | Array<Record<string, unknown>> | null;
      if (!response.ok) {
        const errorBody = data && !Array.isArray(data) ? data : {};
        const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? randomUUID();
        const apiKeySafeMessage = typeof errorBody.message === "string" ? errorBody.message : typeof errorBody.error === "string" ? errorBody.error : null;
        logEvent("warn", "Instantly preflight endpoint unavailable", {
          correlationId: requestId.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 100) || randomUUID(),
          provider: "instantly",
          endpointCategory,
          httpStatus: response.status,
          providerErrorCode: typeof errorBody.error_code === "string" ? errorBody.error_code : typeof errorBody.code === "string" ? errorBody.code : null,
          providerMessage: apiKeySafeMessage
            ?.replaceAll(apiKey!, "[REDACTED]")
            .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
            .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
            .slice(0, 300) ?? null,
        });
      }
      return { status: response.status, ok: response.ok, data };
    } catch (error) {
      logEvent("warn", "Instantly preflight endpoint unavailable", {
        correlationId: randomUUID(),
        provider: "instantly",
        endpointCategory,
        httpStatus: null,
        providerErrorCode: safeErrorCode(error),
        providerMessage: null,
      });
      return { status: null, ok: false, data: null };
    }
  }

  const [planResponse, analyticsResponse, campaignResponse] = await Promise.all([
    readEndpoint("plan-details", `${instantlyApiBaseUrl}/workspace-billing/plan-details`),
    readEndpoint("analytics", analyticsUrl),
    readEndpoint("campaign", `${instantlyApiBaseUrl}/campaigns/${encodeURIComponent(campaignId)}`),
  ]);
  const planData = planResponse.data as {
    subscriptions?: { outreach?: { current_lead_count?: number; total_lead_limit?: number }; bundle?: { current_lead_count?: number; total_lead_limit?: number } };
  } | null;
  const analyticsData = analyticsResponse.data as Array<{ emails_sent_count?: number }> | null;
  const campaignData = campaignResponse.data as { id?: string; campaign?: { id?: string } } | null;
  const plan = planData?.subscriptions?.outreach ?? planData?.subscriptions?.bundle;
    const uploadedContacts = plan?.current_lead_count;
    const providerContactLimit = plan?.total_lead_limit;
    const monthlyEmailsSent = Array.isArray(analyticsData)
      && analyticsData.every((row) => Number.isFinite(row.emails_sent_count))
      ? analyticsData.reduce((total, row) => total + (row.emails_sent_count ?? 0), 0)
      : null;
    const campaignAccessible = campaignResponse.ok
      && (campaignData?.id === campaignId || campaignData?.campaign?.id === campaignId);
    const planReadable = planResponse.ok && Number.isFinite(uploadedContacts) && Number.isFinite(providerContactLimit);
    const analyticsReadable = analyticsResponse.ok && monthlyEmailsSent !== null;
    const campaignReadAuth = campaignResponse.ok && campaignAccessible ? "PASS" : "FAIL";
    const configurationReady = configured && campaignId === instantlyCampaignId;
    const leadWriteProof = await readRecentLeadWriteProof(campaignId);
    const leadsWrite = leadWriteProof ? "PASS" : "NOT_TESTED";
    const instantlyLeadImportReady = configurationReady && campaignReadAuth === "PASS" && leadsWrite === "PASS";
    const telemetryReady = planReadable && analyticsReadable;
    const billingReadAuth = planReadable ? "PASS" : "OPTIONAL_FAIL";
    const analyticsReadAuth = analyticsReadable ? "PASS" : "OPTIONAL_FAIL";

    return {
      configured,
      configurationReady,
      campaignRead: campaignReadAuth,
      leadsWrite,
      writeProof: leadWriteProof ? "LEADS_WRITE_RECENTLY_PROVEN" : "NOT_TESTED",
      instantlyLeadImportReady,
      lastSuccessfulLeadWriteAt: leadWriteProof?.occurredAt ?? null,
      lastSuccessfulLeadWriteCampaignId: leadWriteProof?.providerCampaignId ?? null,
      lastSuccessfulLeadWriteRequestIdSanitized: null,
      telemetryReady,
      campaignAccessible,
      campaignId,
      auth: {
        leadsWrite,
        campaignRead: campaignReadAuth,
        analyticsRead: analyticsReadAuth,
        billingRead: billingReadAuth,
      },
      httpStatus: { plan: planResponse.status, analytics: analyticsResponse.status, campaign: campaignResponse.status },
      planUsage: {
        uploadedContacts: Number.isFinite(uploadedContacts) ? uploadedContacts : null,
        providerContactLimit: Number.isFinite(providerContactLimit) ? providerContactLimit : null,
        contactLimit: Number.isFinite(providerContactLimit) ? Math.min(providerContactLimit!, limits.contactLimit) : limits.contactLimit,
        monthlyEmailsSent,
        monthlyEmailLimit: limits.monthlyEmailLimit,
        contactWarningThreshold: limits.contactWarningThreshold,
        monthlyEmailWarningThreshold: limits.monthlyEmailWarningThreshold,
      },
      errorCode: !configurationReady
        ? "CAMPAIGN_ID_MISMATCH"
        : campaignReadAuth !== "PASS"
          ? "CAMPAIGN_UNAVAILABLE"
          : "LEADS_WRITE_NOT_TESTED",
      limits,
    };
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  const startedAt = Date.now();
  const [database, millionVerifier, instantly, historicalFunnel] = await Promise.all([
    readDatabaseState(),
    readMillionVerifierState(),
    readInstantlyState(),
    readHistoricalFunnel(),
  ]);
  const schemaReady = database.healthy
    && database.through0017
    && database.instantlyTablesExist
    && database.requiredIndexesPresent;
  const instantlyLeadImportReady = instantly.configurationReady
    && schemaReady
    && instantly.campaignRead === "PASS"
    && instantly.leadsWrite === "PASS";
    const instantlyWithSchema = { ...instantly, schemaReady, instantlyLeadImportReady };
  const instantlyTelemetryReady = instantly.telemetryReady;
  const healthy = instantlyLeadImportReady
    && millionVerifier.healthy
    && millionVerifier.creditsAvailable;

  logEvent("info", "cron.provider-preflight", {
    correlationId: randomUUID(),
    outcome: healthy ? "healthy" : "blocked",
    durationMs: Date.now() - startedAt,
    databaseConfigured: database.configured,
    databaseHealthy: database.healthy,
    through0016: database.through0016,
    through0017: database.through0017,
    migration0017Applied: database.migration0017Applied,
    instantlyTablesExist: database.instantlyTablesExist,
    requiredIndexesPresent: database.requiredIndexesPresent,
    databaseErrorCode: database.errorCode,
    millionVerifierConfigured: millionVerifier.configured,
    millionVerifierProvider: millionVerifier.provider,
    millionVerifierHealthy: millionVerifier.healthy,
    millionVerifierCreditsAvailable: millionVerifier.creditsAvailable,
    millionVerifierCreditsRemaining: millionVerifier.creditsRemaining,
    millionVerifierHttpStatus: millionVerifier.httpStatus,
    millionVerifierErrorCode: millionVerifier.errorCode,
    instantlyConfigured: instantly.configurationReady,
    instantlySchemaReady: schemaReady,
    instantlyCampaignRead: instantly.campaignRead,
    instantlyLeadsWrite: instantly.leadsWrite,
    instantlyLeadImportReady,
    instantlyTelemetryReady,
    instantlyCampaignAccessible: instantly.campaignAccessible,
    instantlyCampaignId: instantly.campaignId,
    instantlyHttpStatus: instantly.httpStatus,
    instantlyPlanUsage: instantly.planUsage,
    instantlyErrorCode: instantly.errorCode,
  });

  return NextResponse.json({ database, millionVerifier, instantly: instantlyWithSchema, instantlyLeadImportReady, instantlyTelemetryReady, historicalFunnel, healthy }, {
    status: healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}