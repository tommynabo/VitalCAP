import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { EngineType } from "@/domain/campaigns/types";
import { InstantlyEmailDeliveryProvider } from "@/infrastructure/providers/instantly/provider";
import { getDeliveryEnv, getMapsEnv, getSerperEnv, getVerificationEnv, getCoreEnv } from "@/lib/config/env";
import { getDayBounds } from "@/lib/time/day-bounds";
import { emailChannelEligibilitySql } from "@/services/compliance/email-channel-policy";
import { actualPriorColdOutreachSql } from "./actual-outreach";
import { getDb } from "../db";
import { autopilotSettings } from "../schema/autopilot";
import { campaigns } from "../schema/campaigns";
import {
  calculateCostPerConfirmedImport,
  calculateYield,
  DISCOVERY_ENGINE_TYPES,
  estimateRequestsRequiredForTarget,
  getCapacityWindowBounds,
  rollupConfirmedImports,
  sameCohortYield,
  totalConfirmedImports,
  type CapacityWindow,
  type ConfirmedImportFact,
} from "@/services/admin/production-capacity-metrics";

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

  const [sourceResult, requestResult, spendResult, importResult, dailyRequestResult] = await Promise.all([
    db.execute(sql`
      WITH periods(name, start_at, end_at) AS ${periodValues}
      SELECT periods.name AS window, raw.engine_type AS engine,
        COUNT(*)::int AS source_rows,
        COUNT(DISTINCT raw.account_id)::int AS unique_accounts,
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
      GROUP BY periods.name, raw.engine_type
    `),
    db.execute(sql`
      WITH periods(name, start_at, end_at) AS ${periodValues}
      SELECT periods.name AS window,
        COALESCE(provider_run.metadata->>'engineType', campaign.engine_type) AS engine,
        COUNT(*)::int AS provider_calls,
        COALESCE(SUM(provider_run.items_requested), 0)::int AS requests
      FROM periods
      JOIN provider_runs provider_run ON provider_run.started_at >= periods.start_at AND provider_run.started_at < periods.end_at
      LEFT JOIN campaigns campaign ON campaign.id = provider_run.campaign_id AND campaign.workspace_id = provider_run.workspace_id
      WHERE provider_run.workspace_id = ${workspaceId}::uuid
        AND provider_run.provider IN ('apify', 'serper')
        AND provider_run.status <> 'budget_blocked'
        AND COALESCE(provider_run.metadata->>'engineType', campaign.engine_type) IS NOT NULL
      GROUP BY periods.name, engine
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
  for (const row of requestResult.rows as RawRow[]) requestMetrics.set(`${row.window}:${row.engine}`, row);
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
      sourceRows: number;
      uniqueAccounts: number;
      withEmail: number;
      mvValid: number;
      eligible: number;
      confirmedInstantlyImports: number;
      sameCohortConfirmedImports: number;
      backlogConfirmedImports: number;
      requestToConfirmedImportYield: number | null;
      accountToEmailYield: number | null;
      accountToMvValidYield: number | null;
    }>;
    for (const window of ["today", "rolling3d", "rolling7d"] as const) {
      const source = sourceMetrics.get(`${window}:${engine}`);
      const request = requestMetrics.get(`${window}:${engine}`);
      const requests = asNumber(request?.requests);
      const uniqueAccounts = asNumber(source?.unique_accounts);
      const withEmail = asNumber(source?.with_email);
      const mvValid = asNumber(source?.mv_valid);
      const confirmedInstantlyImports = importRollup.byWindow[window].sameCohortByEngine[engine] ?? 0;
      const backlogConfirmedImports = importRollup.byWindow[window].backlogByEngine[engine] ?? 0;
      periods[window] = {
        requests,
        providerCalls: asNumber(request?.provider_calls),
        sourceRows: asNumber(source?.source_rows),
        uniqueAccounts,
        withEmail,
        mvValid,
        eligible: asNumber(source?.eligible),
        confirmedInstantlyImports,
        sameCohortConfirmedImports: confirmedInstantlyImports,
        backlogConfirmedImports,
        requestToConfirmedImportYield: calculateYield(confirmedInstantlyImports, requests),
        accountToEmailYield: calculateYield(withEmail, uniqueAccounts),
        accountToMvValidYield: calculateYield(mvValid, uniqueAccounts),
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

  return {
    generatedAt: now.toISOString(),
    workspaceId,
    timezone,
    globalRawRequestCap: coreEnv.ACTIVATION_MAX_DAILY_RAW_REQUESTS,
    engines: engineMetrics,
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
        requestsRequiredMethod: {
          percentile: "nearest-rank, rank = ceil(p * n)",
          sampleFormula: "ceil(requests_in_day / same_cohort_confirmed_imports_in_day * 250)",
          sampleCount: requiredRequests.sampleCount,
          dailySamples,
          minimumSamples: 3,
        },
    bestEngineByConfirmedImportYield: rankedEngines[0]?.engine ?? null,
    worstEngineByConfirmedImportYield: rankedEngines.at(-1)?.engine ?? null,
    recommendedGlobalRawCap: null,
    safeToRaiseCap: false,
    recommendationReason: "Provider-run spend is estimate-based and provider/Instantly hard-cap headroom is not fully measurable.",
  };
}