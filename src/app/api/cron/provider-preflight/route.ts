import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getNeonSql } from "@/infrastructure/neon/db";
import { getDatabaseEnv, getDeliveryEnv, getVerificationEnv } from "@/lib/config/env";
import { logEvent } from "@/lib/observability/structured-logger";
import { isAuthorizedCronRequest, unauthorizedCronResponse } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

const requiredMigrations = [
  "0013_global_deduplication.sql",
  "0014_setter_runtime.sql",
  "0015_email_verification_pipeline.sql",
  "0016_email_verification_cache_version.sql",
] as const;
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
      migration0017Applied: applied.has("0017_instantly_lead_imports.sql"),
      instantlyTablesExist: tablesExist,
      requiredIndexesPresent: tablesExist && requiredInstantlyIndexes.every((index) => indexes.has(index)),
      missingMigrations: requiredMigrations.filter((filename) => !applied.has(filename)),
      errorCode: migrationLedgerExists ? null : "MIGRATION_LEDGER_MISSING",
    };
  } catch {
    return {
      configured: true,
      healthy: false,
      through0016: false,
      migration0017Applied: false,
      instantlyTablesExist: false,
      requiredIndexesPresent: false,
      errorCode: "DATABASE_PREFLIGHT_FAILED",
    };
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
      healthy: false,
      campaignAccessible: false,
      campaignId,
      httpStatus: { plan: null, analytics: null, campaign: null },
      planUsage: null,
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

  try {
    const [planResponse, analyticsResponse, campaignResponse] = await Promise.all([
      fetch(`${instantlyApiBaseUrl}/workspace-billing/plan-details`, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" }),
      fetch(analyticsUrl, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" }),
      fetch(`${instantlyApiBaseUrl}/campaigns/${encodeURIComponent(campaignId)}`, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" }),
    ]);
    const [planData, analyticsData, campaignData] = await Promise.all([
      planResponse.json().catch(() => null) as Promise<{
        subscriptions?: { outreach?: { current_lead_count?: number; total_lead_limit?: number }; bundle?: { current_lead_count?: number; total_lead_limit?: number } };
      } | null>,
      analyticsResponse.json().catch(() => null) as Promise<Array<{ emails_sent_count?: number }> | null>,
      campaignResponse.json().catch(() => null) as Promise<{ id?: string; campaign?: { id?: string } } | null>,
    ]);
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
    const healthy = planReadable && analyticsReadable && campaignAccessible && campaignId === instantlyCampaignId;
    const failedStatus = [planResponse, analyticsResponse, campaignResponse].find((response) => !response.ok)?.status ?? null;

    return {
      configured,
      healthy,
      campaignAccessible,
      campaignId,
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
      errorCode: healthy ? null : campaignId !== instantlyCampaignId ? "CAMPAIGN_ID_MISMATCH" : failedStatus === 401 || failedStatus === 403 ? "PROVIDER_UNAUTHORIZED" : "PROVIDER_PREFLIGHT_FAILED",
      limits,
    };
  } catch (error) {
    return {
      configured,
      healthy: false,
      campaignAccessible: false,
      campaignId,
      httpStatus: { plan: null, analytics: null, campaign: null },
      planUsage: null,
      errorCode: safeErrorCode(error),
      limits,
    };
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  const startedAt = Date.now();
  const [database, millionVerifier, instantly] = await Promise.all([
    readDatabaseState(),
    readMillionVerifierState(),
    readInstantlyState(),
  ]);
  const healthy = database.healthy
    && database.through0016
    && millionVerifier.healthy
    && millionVerifier.creditsAvailable
    && instantly.healthy;

  logEvent("info", "cron.provider-preflight", {
    correlationId: randomUUID(),
    outcome: healthy ? "healthy" : "blocked",
    durationMs: Date.now() - startedAt,
    databaseConfigured: database.configured,
    databaseHealthy: database.healthy,
    through0016: database.through0016,
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
    instantlyConfigured: instantly.configured,
    instantlyHealthy: instantly.healthy,
    instantlyCampaignAccessible: instantly.campaignAccessible,
    instantlyCampaignId: instantly.campaignId,
    instantlyHttpStatus: instantly.httpStatus,
    instantlyPlanUsage: instantly.planUsage,
    instantlyErrorCode: instantly.errorCode,
  });

  return NextResponse.json({ database, millionVerifier, instantly, healthy }, {
    status: healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}