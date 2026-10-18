import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { EngineType } from "@/domain/campaigns/types";
import { InstantlyEmailDeliveryProvider } from "@/infrastructure/providers/instantly/provider";
import { getDeliveryEnv, getMapsEnv, getSerperEnv, getVerificationEnv, getCoreEnv } from "@/lib/config/env";
import { getDayBounds } from "@/lib/time/day-bounds";
import { emailChannelEligibilitySql } from "@/services/compliance/email-channel-policy";
import { actualPriorColdOutreachSql } from "./actual-outreach";
import { buildDeadLetterAggregateQuery } from "./production-capacity-diagnostics-sql";
import { getDb } from "../db";
import { autopilotSettings } from "../schema/autopilot";
import { campaigns } from "../schema/campaigns";
import {
  calculateCostPerConfirmedImport,
  calculateYield,
  buildCapacityScenarios,
  DISCOVERY_ENGINE_TYPES,
  estimateRequestsRequiredForTarget,
  getCapacityWindowBounds,
  rollupConfirmedImports,
  sameCohortYield,
  totalConfirmedImports,
  type CapacityWindow,
  type ConfirmedImportFact,
} from "@/services/admin/production-capacity-metrics";
import { calculateProductionPipelineRates, classifyProductionPrimaryLossStage } from "@/services/admin/production-pipeline-metrics";

type RawRow = Record<string, unknown>;

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function totalImportsByWindow(result: ReturnType<typeof rollupConfirmedImports>, window: CapacityWindow): number {
  return totalConfirmedImports(result.byWindow[window]);
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function getProductionCapacityDiagnostics(workspaceId: string, now = new Date()) {
  const db = getDb();
  const [[settings], activeCampaigns] = await Promise.all([
    db.select({ timezone: autopilotSettings.timezone, maxDailyApifySpendUsd: autopilotSettings.maxDailyApifySpendUsd })
      .from(autopilotSettings)
      .where(eq(autopilotSettings.workspaceId, workspaceId))
      .limit(1),
    db.selectDistinct({ engineType: campaigns.engineType })
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active"))),
  ]);

  const timezone = settings?.timezone ?? "Europe/Madrid";
  const todayBounds = getDayBounds(timezone, now);
  const windows = getCapacityWindowBounds(now, todayBounds.start);
  const completedDailyWindows = [];
  let completedDayCursor = new Date(todayBounds.start.getTime() - 1);
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const bounds = getDayBounds(timezone, completedDayCursor);
    completedDailyWindows.unshift(bounds);
    completedDayCursor = new Date(bounds.start.getTime() - 1);
  }
  const completedHistoryStart = completedDailyWindows[0]!.start.toISOString();
  const mapsEnv = getMapsEnv();
  const serperEnv = getSerperEnv();
  const verificationEnv = getVerificationEnv();
  const deliveryEnv = getDeliveryEnv();
  const coreEnv = getCoreEnv();
  const sevenDayStart = windows.rolling7d.start.toISOString();
  const targetProviderCampaignId = deliveryEnv.INSTANTLY_CAMPAIGN_ID;
  const engineArray = sql`ARRAY[${sql.join(DISCOVERY_ENGINE_TYPES.map((engine) => sql`${engine}`), sql`, `)}]::text[]`;
  const periodValues = sql`(VALUES
    (${"today"}, ${windows.today.start.toISOString()}::timestamptz, ${windows.today.end.toISOString()}::timestamptz),
    (${"rolling3d"}, ${windows.rolling3d.start.toISOString()}::timestamptz, ${windows.rolling3d.end.toISOString()}::timestamptz),
    (${"rolling7d"}, ${windows.rolling7d.start.toISOString()}::timestamptz, ${windows.rolling7d.end.toISOString()}::timestamptz)
  )`;

  const [sourceResult, requestResult, spendResult, importResult, dailyRequestResult, deadLetterResult] = await Promise.all([
    db.execute(sql`
      WITH periods(name, start_at, end_at) AS ${periodValues}
      SELECT periods.name AS window, raw.engine_type AS engine,
        COUNT(*)::int AS source_rows,
        COUNT(*) FILTER (WHERE raw.processed)::int AS processed_source_rows,
        COUNT(DISTINCT raw.account_id)::int AS unique_accounts,
        COUNT(DISTINCT account_record.id) FILTER (
          WHERE account_record.created_at >= periods.start_at AND account_record.created_at < periods.end_at
        )::int AS accounts_created,
        COUNT(DISTINCT raw.account_id) FILTER (
          WHERE NULLIF(TRIM(account_record.website_url), '') IS NOT NULL
        )::int AS website_present,
        COUNT(DISTINCT raw.account_id) FILTER (
          WHERE account_record.id IS NOT NULL AND NULLIF(TRIM(account_record.website_url), '') IS NULL
        )::int AS website_missing,
        COUNT(*) FILTER (WHERE raw.processing_metrics IS NOT NULL)::int AS processing_metrics_rows,
        COALESCE(SUM(NULLIF(raw.processing_metrics->>'emailRejectedFormat', '')::int), 0)::int AS email_rejected_format,
        COALESCE(SUM(NULLIF(raw.processing_metrics->>'emailDuplicate', '')::int), 0)::int AS email_duplicate,
        COUNT(DISTINCT raw.account_id) FILTER (
          WHERE NULLIF(TRIM(account_record.website_url), '') IS NOT NULL AND EXISTS (
            SELECT 1 FROM contact_points cp
            WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
              AND cp.type = 'email' AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
          )
        )::int AS website_accounts_with_email,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM website_enrichments enrichment
            WHERE enrichment.workspace_id = source_campaign.workspace_id
              AND enrichment.account_id = raw.account_id
              AND enrichment.normalized_domain = account_record.normalized_domain
          ) OR COALESCE((raw.processing_metrics->>'homepageFetchAttempted')::int, 0) > 0
        )::int AS website_fetch_attempted,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM website_enrichments enrichment
            WHERE enrichment.workspace_id = source_campaign.workspace_id
              AND enrichment.account_id = raw.account_id
              AND enrichment.normalized_domain = account_record.normalized_domain
              AND enrichment.status = 'completed'
          ) OR COALESCE((raw.processing_metrics->>'homepageFetchSucceeded')::int, 0) > 0
        )::int AS website_fetch_succeeded,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM website_enrichments enrichment
            WHERE enrichment.workspace_id = source_campaign.workspace_id
              AND enrichment.account_id = raw.account_id
              AND enrichment.normalized_domain = account_record.normalized_domain
              AND enrichment.status NOT IN ('completed', 'no_website')
          ) OR COALESCE((raw.processing_metrics->>'homepageFetchFailed')::int, 0) > 0
        )::int AS website_fetch_failed,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND cp.source_type = 'provider_source'
            AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
        ))::int AS email_found_from_source,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND cp.source_type IN ('website', 'website_enrichment')
            AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
        ))::int AS email_found_from_website,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND cp.source_type = 'serper_snippet'
            AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
        ))::int AS email_found_from_serper_fallback,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
        ))::int AS accounts_with_email,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
        ) AND raw.processed)::int AS no_email_found,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          JOIN compliance_decisions decision ON decision.contact_point_id = cp.id
            AND decision.workspace_id = source_campaign.workspace_id
            AND decision.campaign_id = raw.campaign_id
            AND decision.decision = 'blocked' AND decision.superseded_at IS NULL
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email'
        ))::int AS email_compliance_rejected,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM campaign_memberships membership
          WHERE membership.campaign_id = raw.campaign_id AND membership.account_id = raw.account_id
            AND membership.stage = 'rejected' AND membership.rejection_reason LIKE 'Rejected ICP:%'
        ))::int AS icp_rejected,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM verification_jobs verification_job
          JOIN contact_points cp ON cp.id = verification_job.contact_point_id
          WHERE verification_job.workspace_id = source_campaign.workspace_id
            AND cp.account_id = raw.account_id AND cp.type = 'email'
        ))::int AS verification_queued,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND cp.verification_status = 'valid'
        ))::int AS verification_valid,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND cp.verification_status IN ('invalid', 'disposable', 'bounced')
        ))::int AS verification_invalid,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id
            AND cp.type = 'email' AND cp.verification_status IN ('unknown', 'unverified')
        ))::int AS verification_unknown,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id AND cp.type = 'email'
            AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
        ))::int AS with_email,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.workspace_id = source_campaign.workspace_id AND cp.account_id = raw.account_id AND cp.type = 'email'
            AND cp.verification_status = 'valid' AND cp.verification_provider = 'millionverifier'
        ))::int AS mv_valid,
        COUNT(DISTINCT raw.account_id) FILTER (WHERE EXISTS (
          SELECT 1
          FROM campaign_memberships cm
          JOIN contact_points cp ON cp.id = cm.selected_contact_point_id AND cp.account_id = raw.account_id
            AND cp.workspace_id = source_campaign.workspace_id
          WHERE cm.campaign_id = raw.campaign_id AND cm.account_id = raw.account_id
            AND cm.stage = 'ready' AND cm.contacted_at IS NULL AND cp.last_contacted_at IS NULL
            AND cp.type = 'email' AND NULLIF(TRIM(cp.normalized_value), '') IS NOT NULL
            AND cp.verification_status = 'valid'
            AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
            AND EXISTS (
              SELECT 1 FROM compliance_decisions cd
              WHERE cd.workspace_id = source_campaign.workspace_id AND cd.campaign_id = cm.campaign_id
                AND cd.account_id = raw.account_id AND cd.contact_point_id = cp.id
                AND cd.decision = 'allowed' AND cd.superseded_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM suppression_entries se
              WHERE se.workspace_id = source_campaign.workspace_id
                AND (se.account_id = raw.account_id OR se.contact_point_id = cp.id)
            )
            AND NOT ${actualPriorColdOutreachSql({
              workspaceId: sql`source_campaign.workspace_id`,
              accountId: sql`raw.account_id`,
              contactPointId: sql`cp.id`,
              normalizedEmail: sql`cp.normalized_value`,
            })}
            AND NOT EXISTS (
              SELECT 1 FROM conversations conv
              WHERE conv.workspace_id = source_campaign.workspace_id AND conv.account_id = raw.account_id
                AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
            )
            AND NOT EXISTS (
              SELECT 1 FROM meetings meeting
              JOIN conversations conv ON conv.id = meeting.conversation_id
              WHERE conv.workspace_id = source_campaign.workspace_id AND conv.account_id = raw.account_id
            )
        ))::int AS eligible
      FROM periods
      JOIN raw_candidates raw ON raw.discovered_at >= periods.start_at AND raw.discovered_at < periods.end_at
      JOIN campaigns source_campaign ON source_campaign.id = raw.campaign_id AND source_campaign.workspace_id = ${workspaceId}::uuid
      LEFT JOIN accounts account_record ON account_record.id = raw.account_id
      GROUP BY periods.name, raw.engine_type
    `),
    db.execute(sql`
      WITH periods(name, start_at, end_at) AS ${periodValues}
      SELECT periods.name AS window, provider_run.provider AS provider,
        COALESCE(provider_run.metadata->>'engineType', campaign.engine_type) AS engine,
        COUNT(*)::int AS provider_calls,
        COALESCE(SUM(provider_run.items_requested), 0)::int AS requests,
        COALESCE(SUM(provider_run.cost_usd), 0)::float AS provider_spend_usd
      FROM periods
      JOIN provider_runs provider_run ON provider_run.started_at >= periods.start_at AND provider_run.started_at < periods.end_at
      LEFT JOIN campaigns campaign ON campaign.id = provider_run.campaign_id AND campaign.workspace_id = provider_run.workspace_id
      WHERE provider_run.workspace_id = ${workspaceId}::uuid
        AND provider_run.provider IN ('apify', 'serper')
        AND provider_run.status <> 'budget_blocked'
        AND COALESCE(provider_run.metadata->>'engineType', campaign.engine_type) IS NOT NULL
      GROUP BY periods.name, provider_run.provider, engine
    `),
    db.execute(sql`
      SELECT provider, COALESCE(SUM(cost_usd) FILTER (WHERE started_at >= ${windows.today.start.toISOString()}::timestamptz AND started_at < ${now.toISOString()}::timestamptz), 0)::float AS spend_today,
        COALESCE(SUM(cost_usd) FILTER (WHERE started_at >= ${sevenDayStart}::timestamptz AND started_at < ${now.toISOString()}::timestamptz), 0)::float AS spend_7d
      FROM provider_runs
      WHERE workspace_id = ${workspaceId}::uuid AND provider IN ('apify', 'serper', 'email_verification')
        AND started_at >= ${sevenDayStart}::timestamptz AND started_at < ${now.toISOString()}::timestamptz
      GROUP BY provider
    `),
    db.execute(sql`
      SELECT imported.workspace_id, imported.account_id, imported.provider_campaign_id, imported.status,
        imported.provider_lead_id, imported.uploaded_at,
        COALESCE(lineage.source_lineage, '[]'::jsonb) AS source_lineage
      FROM instantly_lead_imports imported
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT jsonb_build_object(
          'engineType', sources.engine_type,
          'discoveredAt', sources.discovered_at
        )) FILTER (WHERE sources.engine_type = ANY(${engineArray})) AS source_lineage
        FROM (
          SELECT raw.engine_type, raw.discovered_at
          FROM raw_candidates raw
          JOIN campaigns source_campaign ON source_campaign.id = raw.campaign_id
          WHERE raw.account_id = imported.account_id AND source_campaign.workspace_id = imported.workspace_id
        ) sources
      ) lineage ON TRUE
      WHERE imported.workspace_id = ${workspaceId}::uuid
        AND imported.provider_campaign_id = ${targetProviderCampaignId}
        AND imported.status = 'instantly_added' AND imported.provider_lead_id IS NOT NULL
        AND imported.uploaded_at IS NOT NULL AND imported.uploaded_at >= ${completedHistoryStart}::timestamptz
        AND imported.uploaded_at < ${now.toISOString()}::timestamptz
    `),
    db.execute(sql`
      SELECT (started_at AT TIME ZONE ${timezone})::date::text AS day,
        COALESCE(SUM(items_requested), 0)::int AS requests
      FROM provider_runs
      WHERE workspace_id = ${workspaceId}::uuid AND provider IN ('apify', 'serper')
        AND status <> 'budget_blocked'
        AND started_at >= ${completedHistoryStart}::timestamptz
        AND started_at < ${todayBounds.start.toISOString()}::timestamptz
      GROUP BY day
    `),
    db.execute(buildDeadLetterAggregateQuery(workspaceId, now)),
  ]);

  const confirmedImportFacts: ConfirmedImportFact[] = importResult.rows.map((row: RawRow) => ({
    workspaceId: String(row.workspace_id),
    accountId: String(row.account_id),
    providerCampaignId: String(row.provider_campaign_id),
    status: String(row.status),
    providerLeadId: row.provider_lead_id === null ? null : String(row.provider_lead_id),
    uploadedAt: asDate(row.uploaded_at),
  }));
  const accountSources = importResult.rows.flatMap((row: RawRow) => {
    const lineage = Array.isArray(row.source_lineage) ? row.source_lineage : [];
    return lineage.flatMap((source) => {
      if (!source || typeof source !== "object") return [];
      const record = source as Record<string, unknown>;
      const discoveredAt = asDate(record.discoveredAt);
      if (!discoveredAt) return [];
      return [{
        workspaceId: String(row.workspace_id),
        accountId: String(row.account_id),
        engineType: String(record.engineType),
        discoveredAt,
      }];
    });
  });
  const importRollup = rollupConfirmedImports({
    workspaceId,
    targetProviderCampaignId,
    now,
    todayStart: todayBounds.start,
    imports: confirmedImportFacts,
    sources: accountSources,
  });

  const sourceMetrics = new Map<string, RawRow>();
  for (const row of sourceResult.rows as RawRow[]) sourceMetrics.set(`${row.window}:${row.engine}`, row);
  const requestMetrics = new Map<string, RawRow>();
  for (const row of requestResult.rows as RawRow[]) {
    requestMetrics.set(`${row.window}:${row.engine}:${row.provider}`, row);
  }
  const getRequestMetric = (window: CapacityWindow, engine: string, provider: "apify" | "serper") =>
    requestMetrics.get(`${window}:${engine}:${provider}`);
  const getProviderRequests = (window: CapacityWindow, provider: "apify" | "serper") =>
    Array.from(requestMetrics.values())
      .filter((row) => row.window === window && row.provider === provider)
      .reduce((total, row) => total + asNumber(row.requests), 0);
  const deadLetterGroups = (deadLetterResult.rows as RawRow[]).map((row) => ({
    queueType: String(row.queue_type),
    engine: String(row.engine),
    failureClass: String(row.failure_class),
    ageBucket: String(row.age_bucket),
    count: asNumber(row.count),
  }));
  const activeSystemicDeadLetterCount = deadLetterGroups
    .filter((group) => group.ageBucket === "lt_24h"
      && group.count >= 3
      && ["reservation_parameter_typing", "provider_authentication"].includes(group.failureClass))
    .reduce((total, group) => total + group.count, 0);
  const activeEngineTypes = new Set(activeCampaigns.map((campaign) => String(campaign.engineType)));
  const engineTypes = new Set<string>([
    ...activeEngineTypes,
    ...Array.from(sourceMetrics.values(), (row) => String(row.engine)),
    ...Array.from(requestMetrics.values(), (row) => String(row.engine)),
    ...Object.keys(importRollup.byWindow.rolling7d.sameCohortByEngine),
    ...Object.keys(importRollup.byWindow.rolling7d.backlogByEngine),
  ]);

  const spendByProvider = new Map<string, { today: number; sevenDays: number }>();
  for (const row of spendResult.rows as RawRow[]) {
    spendByProvider.set(String(row.provider), { today: asNumber(row.spend_today), sevenDays: asNumber(row.spend_7d) });
  }
  const importsByEngine7d = importRollup.byWindow.rolling7d.sameCohortByEngine;
  const apifyConfirmedImports = (importsByEngine7d.maps_fast ?? 0)
    + (importsByEngine7d.maps_deep ?? 0)
    + (importsByEngine7d.hybrid_fill ?? 0);
  const serperConfirmedImports = importsByEngine7d.google_serp ?? 0;
  const apifySpend = spendByProvider.get("apify") ?? { today: 0, sevenDays: 0 };
  const serperSpend = spendByProvider.get("serper") ?? { today: 0, sevenDays: 0 };
  const verificationSpend = spendByProvider.get("email_verification") ?? { today: 0, sevenDays: 0 };
  const apifyBudget = settings?.maxDailyApifySpendUsd === null || settings?.maxDailyApifySpendUsd === undefined
    ? mapsEnv.APIFY_DAILY_COST_LIMIT_USD
    : Math.min(mapsEnv.APIFY_DAILY_COST_LIMIT_USD, settings.maxDailyApifySpendUsd);

  const engines = [...engineTypes].filter((engine): engine is EngineType =>
    DISCOVERY_ENGINE_TYPES.includes(engine as EngineType),
  ).sort();
  const engineMetrics = engines.map((engine) => {
    const periods = {} as Record<CapacityWindow, {
      requests: number;
      providerCalls: number;
      providerSpendUsd: number;
      sourceRows: number;
      processedSourceRows: number;
      processingMetricsRows: number;
      uniqueAccounts: number;
      accountsCreated: number;
      websitePresent: number;
      websiteMissing: number;
      websiteAccountsWithEmail: number;
      websiteFetchAttempted: number;
      websiteFetchSucceeded: number;
      websiteFetchFailed: number;
      emailFoundFromSource: number;
      emailFoundFromWebsite: number;
      emailFoundFromSerperFallback: number;
      accountsWithEmail: number;
      noEmailFound: number;
      emailRejectedFormat: number | null;
      emailDuplicate: number | null;
      emailComplianceRejected: number;
      icpRejected: number;
      verificationQueued: number;
      verificationValid: number;
      verificationInvalid: number;
      verificationUnknown: number;
      withEmail: number;
      mvValid: number;
      eligible: number;
      confirmedInstantlyImports: number;
      sameCohortConfirmedImports: number;
      backlogConfirmedImports: number;
      requestToConfirmedImportYield: number | null;
      confirmedImportsPer1000Requests: number | null;
      confirmedImportsPerDollar: number | null;
      accountToEmailYield: number | null;
      accountToMvValidYield: number | null;
      rates: ReturnType<typeof calculateProductionPipelineRates>;
    }>;
    for (const window of ["today", "rolling3d", "rolling7d"] as const) {
      const source = sourceMetrics.get(`${window}:${engine}`);
      const apifyRequest = getRequestMetric(window, engine, "apify");
      const serperRequest = getRequestMetric(window, engine, "serper");
      const requests = asNumber(apifyRequest?.requests) + asNumber(serperRequest?.requests);
      const uniqueAccounts = asNumber(source?.unique_accounts);
      const withEmail = asNumber(source?.with_email);
      const mvValid = asNumber(source?.mv_valid);
      const confirmedInstantlyImports = importRollup.byWindow[window].sameCohortByEngine[engine] ?? 0;
      const backlogConfirmedImports = importRollup.byWindow[window].backlogByEngine[engine] ?? 0;
      const eligible = asNumber(source?.eligible);
      const sourceRows = asNumber(source?.source_rows);
      const processingMetricsRows = asNumber(source?.processing_metrics_rows);
      const processingMetricsComplete = sourceRows === 0 || processingMetricsRows === sourceRows;
      const providerSpendUsd = asNumber(apifyRequest?.provider_spend_usd)
        + asNumber(serperRequest?.provider_spend_usd);
      periods[window] = {
        requests,
        providerCalls: asNumber(apifyRequest?.provider_calls) + asNumber(serperRequest?.provider_calls),
        providerSpendUsd,
        sourceRows,
        processedSourceRows: asNumber(source?.processed_source_rows),
        processingMetricsRows,
        uniqueAccounts,
        accountsCreated: asNumber(source?.accounts_created),
        websitePresent: asNumber(source?.website_present),
        websiteMissing: asNumber(source?.website_missing),
        websiteAccountsWithEmail: asNumber(source?.website_accounts_with_email),
        websiteFetchAttempted: asNumber(source?.website_fetch_attempted),
        websiteFetchSucceeded: asNumber(source?.website_fetch_succeeded),
        websiteFetchFailed: asNumber(source?.website_fetch_failed),
        emailFoundFromSource: asNumber(source?.email_found_from_source),
        emailFoundFromWebsite: asNumber(source?.email_found_from_website),
        emailFoundFromSerperFallback: asNumber(source?.email_found_from_serper_fallback),
        accountsWithEmail: asNumber(source?.accounts_with_email),
        noEmailFound: asNumber(source?.no_email_found),
        emailRejectedFormat: processingMetricsComplete ? asNumber(source?.email_rejected_format) : null,
        emailDuplicate: processingMetricsComplete ? asNumber(source?.email_duplicate) : null,
        emailComplianceRejected: asNumber(source?.email_compliance_rejected),
        icpRejected: asNumber(source?.icp_rejected),
        verificationQueued: asNumber(source?.verification_queued),
        verificationValid: asNumber(source?.verification_valid),
        verificationInvalid: asNumber(source?.verification_invalid),
        verificationUnknown: asNumber(source?.verification_unknown),
        withEmail,
        mvValid,
        eligible,
        confirmedInstantlyImports,
        sameCohortConfirmedImports: confirmedInstantlyImports,
        backlogConfirmedImports,
        requestToConfirmedImportYield: calculateYield(confirmedInstantlyImports, requests),
        confirmedImportsPer1000Requests: requests > 0 ? confirmedInstantlyImports * 1000 / requests : null,
        confirmedImportsPerDollar: providerSpendUsd > 0 ? confirmedInstantlyImports / providerSpendUsd : null,
        accountToEmailYield: calculateYield(withEmail, uniqueAccounts),
        accountToMvValidYield: calculateYield(mvValid, uniqueAccounts),
        rates: calculateProductionPipelineRates({
          rawCandidates: sourceRows,
          processedRawCandidates: asNumber(source?.processed_source_rows),
          accountsLinked: uniqueAccounts,
          websitePresent: asNumber(source?.website_present),
          websiteAccountsWithEmail: asNumber(source?.website_accounts_with_email),
          accountsWithEmail: asNumber(source?.accounts_with_email),
          verificationValid: asNumber(source?.verification_valid),
          eligible,
          instantlyImported: confirmedInstantlyImports,
        }),
      };
    }
    return { engine, active: activeEngineTypes.has(engine), periods };
  });

  const dailyRequests = new Map<string, number>();
  for (const row of dailyRequestResult.rows as RawRow[]) dailyRequests.set(String(row.day), asNumber(row.requests));
  const dailySamples = completedDailyWindows.map((dayBounds) => {
    const dayRollup = rollupConfirmedImports({
      workspaceId,
      targetProviderCampaignId,
      now: dayBounds.end,
      todayStart: dayBounds.start,
      imports: confirmedImportFacts,
      sources: accountSources,
    });
    return {
      day: localDateKey(dayBounds.start, timezone),
      requests: dailyRequests.get(localDateKey(dayBounds.start, timezone)) ?? 0,
      confirmedImports: Object.values(dayRollup.byWindow.today.sameCohortByEngine)
        .reduce((total, count) => total + (count ?? 0), 0),
    };
  });
  const requiredRequests = estimateRequestsRequiredForTarget(dailySamples, 250);
  const successfulDaySamples = requiredRequests.sampleCount;

  const requestTotals = (window: CapacityWindow) => engineMetrics.reduce((sum, metric) => sum + metric.periods[window].requests, 0);
  const rolling3dRequests = requestTotals("rolling3d");
  const rolling7dRequests = requestTotals("rolling7d");
  const rolling3dImports = totalImportsByWindow(importRollup, "rolling3d");
  const rolling7dImports = totalImportsByWindow(importRollup, "rolling7d");
  const rolling3dSameCohortImports = Object.values(importRollup.byWindow.rolling3d.sameCohortByEngine)
    .reduce((total, count) => total + (count ?? 0), 0);
  const rolling7dSameCohortImports = Object.values(importRollup.byWindow.rolling7d.sameCohortByEngine)
    .reduce((total, count) => total + (count ?? 0), 0);
  const rankedEngines = engineMetrics
    .map((metric) => ({ engine: metric.engine, yield: metric.periods.rolling7d.requestToConfirmedImportYield }))
    .filter((metric): metric is { engine: EngineType; yield: number } => metric.yield !== null)
    .sort((left, right) => right.yield - left.yield);
  const recordedSevenDayCosts = apifySpend.sevenDays + serperSpend.sevenDays + verificationSpend.sevenDays;
  const planProvider = new InstantlyEmailDeliveryProvider();
  const [planUsage, monthlyUsage] = await Promise.all([
    planProvider.getPlanUsage().catch(() => null),
    planProvider.getMonthlyEmailUsage(now).catch(() => null),
  ]);
  const apifyRolling7dRequests = getProviderRequests("rolling7d", "apify");
  const serperRolling7dRequests = getProviderRequests("rolling7d", "serper");
  const capacityScenarios = buildCapacityScenarios({
    estimates: requiredRequests,
    rolling7d: {
      finalYield: sameCohortYield(importRollup.byWindow.rolling7d, rolling7dRequests),
      totalRequests: rolling7dRequests,
      apifyRequests: apifyRolling7dRequests,
      serperRequests: serperRolling7dRequests,
      apifySpendUsd: apifySpend.sevenDays,
      serperSpendUsd: serperSpend.sevenDays,
      verificationSpendUsd: verificationSpend.sevenDays,
    },
  });
  const currentMonthlySendHeadroom = monthlyUsage
    ? Math.max(0, deliveryEnv.INSTANTLY_MAX_MONTHLY_EMAILS - monthlyUsage.emailsSent)
    : null;
  const initialEmailsPerDay = 250;
  const expectedFollowupsPerDay = 0;
  const requiredMonthlySendCapacity = (initialEmailsPerDay + expectedFollowupsPerDay) * 30;
  const currentRawRequestCap = coreEnv.ACTIVATION_MAX_DAILY_RAW_REQUESTS;
  const baseScenario = capacityScenarios.BASE;
  const baseRawRequestsWithBuffer = baseScenario.rawRequestsWith20PercentBuffer;
  const monthlySendCapacityIncrease = currentMonthlySendHeadroom === null
    ? null
    : Math.max(0, requiredMonthlySendCapacity - currentMonthlySendHeadroom);
  const configuredMonthlySendLimitIncrease = monthlyUsage
    ? Math.max(0, monthlyUsage.emailsSent + requiredMonthlySendCapacity - deliveryEnv.INSTANTLY_MAX_MONTHLY_EMAILS)
    : null;
  const requiredApifyBudgetIncreaseUsd = baseScenario.apifyDailyCostUsd === null
    ? null
    : Math.max(0, baseScenario.apifyDailyCostUsd - apifyBudget);
  const requiredSerperBudgetIncreaseUsd = baseScenario.serperDailyCostUsd === null
    ? null
    : Math.max(0, baseScenario.serperDailyCostUsd - serperEnv.SERPER_DAILY_COST_LIMIT_USD);
  const requiredVerificationBudgetIncreaseUsd = baseScenario.verificationDailyCostUsd === null
    ? null
    : Math.max(0, baseScenario.verificationDailyCostUsd - verificationEnv.EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD);
  const bestEngineMix = [...engineMetrics]
    .map((metric) => ({
      engine: metric.engine,
      active: metric.active,
      requestShare: rolling7dRequests > 0 ? metric.periods.rolling7d.requests / rolling7dRequests : null,
      rolling7dRequests: metric.periods.rolling7d.requests,
      confirmedImports: metric.periods.rolling7d.sameCohortConfirmedImports,
      confirmedImportsPer1000Requests: metric.periods.rolling7d.confirmedImportsPer1000Requests,
      confirmedImportsPerDollar: metric.periods.rolling7d.confirmedImportsPerDollar,
    }))
    .sort((left, right) => (right.confirmedImportsPer1000Requests ?? -1) - (left.confirmedImportsPer1000Requests ?? -1));
  const mapsFastRolling7d = engineMetrics.find((metric) => metric.engine === "maps_fast")?.periods.rolling7d;
  const googleSerpRolling7d = engineMetrics.find((metric) => metric.engine === "google_serp")?.periods.rolling7d;
  const primaryLossStages = Object.fromEntries(engineMetrics.map((metric) => {
    const period = metric.periods.rolling7d;
    return [metric.engine, {
      stage: classifyProductionPrimaryLossStage({
        rawCandidates: period.sourceRows,
        accountsLinked: period.uniqueAccounts,
        websiteMissing: period.websiteMissing,
        websiteFetchFailed: period.websiteFetchFailed,
        websiteFetchSucceeded: period.websiteFetchSucceeded,
        websiteAccountsWithEmail: period.websiteAccountsWithEmail,
        emailRejectedFormat: period.emailRejectedFormat,
        emailDuplicate: period.emailDuplicate,
        accountsWithEmail: period.accountsWithEmail,
        verificationValid: period.verificationValid,
        icpRejected: period.icpRejected,
        eligible: period.eligible,
        instantlyImported: period.confirmedInstantlyImports,
      }),
      confidence: period.emailRejectedFormat === null || period.emailDuplicate === null ? "partial" : "complete",
    }];
  }));
  const instantlySupports250NewLeadsPerDay = currentMonthlySendHeadroom !== null
    && currentMonthlySendHeadroom >= requiredMonthlySendCapacity;
  const canSupport250FinalLeadsPerDayNow = instantlySupports250NewLeadsPerDay
    && baseRawRequestsWithBuffer !== null
    && currentRawRequestCap >= baseRawRequestsWithBuffer;

  return {
    generatedAt: now.toISOString(),
    workspaceId,
    timezone,
    globalRawRequestCap: coreEnv.ACTIVATION_MAX_DAILY_RAW_REQUESTS,
    safeRawCapNow: currentRawRequestCap,
    engines: engineMetrics,
    pipelineFunnel: {
      attribution: "Stage populations are account-level by raw-candidate engine and discovery window; email rejection and duplicate totals are processing events. Source, website, and Serper email counts can overlap when an account has multiple email origins. Legacy engine-labeled contact points are not counted as provider-source emails because their origin is ambiguous.",
      websiteFetchCoverage: "Account-level fetch outcomes include the candidate processor's persisted homepage attempt and website_enrichments recovery records. Historical homepage outcomes before the processing_metrics migration are not reconstructable.",
      emailTelemetryCoverage: "Format-rejection and duplicate counts are null unless every raw candidate in that engine/window has persisted processing metrics.",
      serperFallbackExecution: {
        mapsFast: serperEnv.SERP_PROVIDER === "serper" ? "NOT_INVOKED_BY_MAPS_FAST_PROCESSOR" : "SERPER_DISABLED",
        googleSerp: "EXTRACTS_RELEVANT_EMAILS_FROM_EXISTING_RESULT_SNIPPETS; DOES_NOT_ISSUE_A_SEPARATE_FALLBACK_QUERY",
        providerSourceEmailSupport: "NO_CURRENT_DISCOVERY_PROVIDER_CONTRACT_RETURNS_EMAIL_FIELDS",
      },
      byEngine: engineMetrics.map((metric) => ({
        engine: metric.engine,
        active: metric.active,
        periods: Object.fromEntries(Object.entries(metric.periods).map(([window, period]) => [window, {
          rawCandidates: period.sourceRows,
          processedRawCandidates: period.processedSourceRows,
          processingMetricsRows: period.processingMetricsRows,
          processingMetricsComplete: period.sourceRows === 0 || period.processingMetricsRows === period.sourceRows,
          accountsCreated: period.accountsCreated,
          accountsLinked: period.uniqueAccounts,
          websitePresent: period.websitePresent,
          websiteMissing: period.websiteMissing,
          websiteFetchAttempted: period.websiteFetchAttempted,
          websiteFetchSucceeded: period.websiteFetchSucceeded,
          websiteFetchFailed: period.websiteFetchFailed,
          emailFoundFromSource: period.emailFoundFromSource,
          emailFoundFromWebsite: period.emailFoundFromWebsite,
          emailFoundFromSerperFallback: period.emailFoundFromSerperFallback,
          noEmailFound: period.noEmailFound,
          emailRejectedFormat: period.emailRejectedFormat,
          emailDuplicate: period.emailDuplicate,
          emailComplianceRejected: period.emailComplianceRejected,
          icpRejected: period.icpRejected,
          primaryLossStage: primaryLossStages[metric.engine],
          verificationQueued: period.verificationQueued,
          verificationValid: period.verificationValid,
          verificationInvalid: period.verificationInvalid,
          verificationUnknown: period.verificationUnknown,
          eligible: period.eligible,
          instantlyImported: period.confirmedInstantlyImports,
          rates: period.rates,
        }])) ,
      })),
    },
    deadLetters: {
      groups: deadLetterGroups,
      attribution: "Workspace-scoped rows linked through their campaign; orphaned dead letters with a deleted campaign cannot be assigned to a workspace.",
      activeSystemicBug: activeSystemicDeadLetterCount > 0,
      activeSystemicBugCount: activeSystemicDeadLetterCount,
      activeSystemicBugCriteria: "At least three dead letters of the same queue, engine, and reservation parameter-typing or provider-authentication class younger than 24 hours.",
    },
    importAttribution: {
      semantics: "Account-level raw-candidate lineage; same-cohort requires a linked raw candidate discovered inside the import reporting window. Older linked candidates are backlog. Accounts linked to multiple engines are multi-source, never assigned to one engine.",
      missingLinkage: "Instantly import rows have account/contact-point links but no direct raw_candidate_id, provider_run_id, or discovery-engine field; attribution is account-level, not exact email-origin lineage. account_sources.discovered_at is excluded because it defaults to processing time.",
      unattributedImports: {
        today: importRollup.byWindow.today.unattributed,
        rolling3d: importRollup.byWindow.rolling3d.unattributed,
        rolling7d: importRollup.byWindow.rolling7d.unattributed,
      },
      multiSourceImports: {
        today: importRollup.byWindow.today.multiSource,
        rolling3d: importRollup.byWindow.rolling3d.multiSource,
        rolling7d: importRollup.byWindow.rolling7d.multiSource,
      },
      backlogConfirmedImports: {
        today: importRollup.byWindow.today.backlogByEngine,
        rolling3d: importRollup.byWindow.rolling3d.backlogByEngine,
        rolling7d: importRollup.byWindow.rolling7d.backlogByEngine,
      },
    },
    providerSpend: {
      actualProviderBilling: {
        status: "UNAVAILABLE" as const,
        detail: "Provider-run telemetry is not an invoice or billing export.",
      },
      configuredSpendGuards: {
        apifyDailyUsd: apifyBudget,
        apifyGlobalDailyUsd: mapsEnv.APIFY_DAILY_COST_LIMIT_USD,
        apifyWorkspaceDailyUsd: settings?.maxDailyApifySpendUsd ?? null,
        serperDailyUsd: serperEnv.SERPER_DAILY_COST_LIMIT_USD,
        millionVerifierDailyUsd: verificationEnv.EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD,
      },
      spendEstimates: {
        apify: {
          source: "provider-reported actor usage; not billing export",
          todayUsd: roundCost(apifySpend.today),
          rolling7dUsd: roundCost(apifySpend.sevenDays),
          costPerSameCohortImport7dUsd: calculateCostPerConfirmedImport(apifySpend.sevenDays, apifyConfirmedImports),
        },
        serper: {
          source: "configured code estimate per query",
          todayUsd: roundCost(serperSpend.today),
          rolling7dUsd: roundCost(serperSpend.sevenDays),
          costPerSameCohortImport7dUsd: calculateCostPerConfirmedImport(serperSpend.sevenDays, serperConfirmedImports),
        },
        millionVerifier: {
          source: "configured code estimate per verified email",
          todayUsd: roundCost(verificationSpend.today),
          rolling7dUsd: roundCost(verificationSpend.sevenDays),
        },
        overallCostPerSameCohortImport7dUsd: calculateCostPerConfirmedImport(recordedSevenDayCosts, rolling7dSameCohortImports),
      },
    },
    instantly: {
      totalLeadCapacity: planUsage?.totalLeadLimit ?? null,
      currentLeads: planUsage?.currentLeadCount ?? null,
      remainingLeads: planUsage ? Math.max(0, planUsage.totalLeadLimit - planUsage.currentLeadCount) : null,
      dailyWriteLimit: null,
      batchLimitPerTick: 50,
      writeConcurrency: 2,
      monthlyEmailLimit: deliveryEnv.INSTANTLY_MAX_MONTHLY_EMAILS,
      monthlyEmailsSent: monthlyUsage?.emailsSent ?? null,
      autoSendEnabled: false,
      currentMonthlySendHeadroom,
      newLeadsPerDay: 250,
      initialEmailsPerDay,
      expectedFollowupsPerDay,
      followupProjectionBasis: "0 today: AUTO_SEND is disabled and no active cold-sequence dispatch is wired.",
      requiredMonthlySendCapacity,
      supports250NewLeadsPerDay: instantlySupports250NewLeadsPerDay,
      requiredAdditionalMonthlySendCapacity: monthlySendCapacityIncrease,
      configuredMonthlySendLimitIncrease,
    },
    rolling: {
      rolling3dRequests,
      rolling3dSameCohortConfirmedImports: rolling3dSameCohortImports,
      rolling3dSameCohortYield: sameCohortYield(importRollup.byWindow.rolling3d, rolling3dRequests),
      rolling7dRequests,
      rolling7dSameCohortConfirmedImports: rolling7dSameCohortImports,
      rolling7dSameCohortYield: sameCohortYield(importRollup.byWindow.rolling7d, rolling7dRequests),
      rolling3dOperationalConfirmedImports: rolling3dImports,
      rolling3dOperationalYield: calculateYield(rolling3dImports, rolling3dRequests),
      rolling7dOperationalConfirmedImports: rolling7dImports,
      rolling7dOperationalYield: calculateYield(rolling7dImports, rolling7dRequests),
    },
    requestsRequiredFor250: { ...requiredRequests, successfulDaySamples },
    capacityScenarios,
    yieldAssessment: {
      currentFinalYield: calculateYield(rolling7dSameCohortImports, rolling7dRequests),
      postFixExpectedFinalYield: calculateYield(rolling7dSameCohortImports, rolling7dRequests),
      yieldBugFound: false,
      yieldFixApplied: false,
      basis: "No quality or eligibility bug is proven by the current code evidence; telemetry instrumentation does not claim a yield lift.",
    },
    primaryLossStages,
    mapsFastRolling7d: mapsFastRolling7d ? {
      primaryLossStage: primaryLossStages.maps_fast,
      rawToEmail: mapsFastRolling7d.rates.rawToEmail,
      rawToImport: mapsFastRolling7d.sourceRows > 0
        ? mapsFastRolling7d.confirmedInstantlyImports / mapsFastRolling7d.sourceRows
        : null,
    } : null,
    googleSerpRolling7d: googleSerpRolling7d ? {
      rawToEmail: googleSerpRolling7d.rates.rawToEmail,
      rawToImport: googleSerpRolling7d.sourceRows > 0
        ? googleSerpRolling7d.confirmedInstantlyImports / googleSerpRolling7d.sourceRows
        : null,
    } : null,
    bestEngineMix: {
      policy: "Keep the observed Maps Fast lead; rank by rolling-7d confirmed imports per 1,000 requests and per provider dollar, retain bounded exploration, and do not reduce Maps Fast from the four-candidate sample.",
      observedRequestMix: bestEngineMix,
    },
    baseCapacityRequirements: {
      rawRequestsFor250: baseScenario.rawRequestsFor250,
      rawRequestsWith20PercentBuffer: baseRawRequestsWithBuffer,
      safeRawCapNow: currentRawRequestCap,
      expectedApifyDailyCostUsd: baseScenario.apifyDailyCostUsd,
      expectedSerperDailyCostUsd: baseScenario.serperDailyCostUsd,
      expectedVerificationDailyCostUsd: baseScenario.verificationDailyCostUsd,
      requiredApifyBudgetIncreaseUsd,
      requiredSerperBudgetIncreaseUsd,
      requiredVerificationBudgetIncreaseUsd,
      canSupport250FinalLeadsPerDayNow,
    },
        requestsRequiredMethod: {
          percentile: "nearest-rank, rank = ceil(p * n)",
          sampleFormula: "ceil(requests_in_day / same_cohort_confirmed_imports_in_day * 250)",
          sampleCount: requiredRequests.sampleCount,
          dailySamples,
          minimumSamples: 3,
        },
    bestEngineByConfirmedImportYield: rankedEngines[0]?.engine ?? null,
    worstEngineByConfirmedImportYield: rankedEngines.at(-1)?.engine ?? null,
    recommendedGlobalRawCap: currentRawRequestCap,
    safeToRaiseCap: false,
    recommendationReason: "Keep the current cap until complete measured windows and Instantly monthly headroom support the buffered base scenario.",
  };
}