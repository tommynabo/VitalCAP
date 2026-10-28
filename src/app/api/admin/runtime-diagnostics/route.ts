import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/infrastructure/neon/db";
import { listCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { autopilotSettings } from "@/infrastructure/neon/schema/autopilot";
import { getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";
import { getApifyRecoverySnapshot, getRecentProviderUsage, getSerperCostDiagnostics, getSerperRecoveryState } from "@/infrastructure/neon/repositories/provider-runs";
import { getApifyDailyEconomicTotals, getSeedEconomicPerformance, listSearchSeedsForCampaignEngine } from "@/infrastructure/neon/repositories/discovery";
import { getSystemHealthDiagnostics } from "@/infrastructure/neon/repositories/health-diagnostics";
import { getRecoveryProbeDiscoveryJobs, getWatchdogWorkspaceSignals } from "@/infrastructure/neon/repositories/watchdog-signals";
import { getAutopilotPacingState } from "@/infrastructure/neon/repositories/autopilot";
import { getCurrentWorkspaceId, requireCurrentUser, UnauthorizedError } from "@/lib/auth/workspace";
import { getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { resolveNeonVar } from "@/lib/config/env-utils";
import { buildProviderHealthSnapshot, evaluateProviderHealth } from "@/services/discovery/provider-health";
import { getWatchdogPausePredicates } from "@/services/autopilot/watchdog-pause-policy";
import { scoreSeedEconomicPerformance } from "@/services/discovery/seed-economics";
import type { SeedEconomicPerformance } from "@/services/discovery/seed-economics";
import { sanitizeRecoveryJobError } from "./sanitize-recovery-error";
import { SERPER_LINKEDIN_DAILY_EXPLORATION_LIMIT_USD } from "@/infrastructure/providers/serp/serper-provider";

export const dynamic = "force-dynamic";

function getDatabaseIdentity() {
  const connectionString = resolveNeonVar("DATABASE_URL");
  if (!connectionString) return { databaseHostMasked: null, databaseName: null };

  try {
    const databaseUrl = new URL(connectionString);
    const [hostLabel = "", ...hostSuffix] = databaseUrl.hostname.split(".");
    return {
      databaseHostMasked: hostSuffix.length > 0
        ? `${hostLabel.slice(0, 5)}***.${hostSuffix.join(".")}`
        : "***",
      databaseName: decodeURIComponent(databaseUrl.pathname.slice(1)) || null,
    };
  } catch {
    return { databaseHostMasked: "configured-unparseable", databaseName: null };
  }
}

function sanitizeApifyFailureMessage(message: string | null): string | null {
  if (!message) return null;
  const bodyStart = message.indexOf("{");
  if (bodyStart >= 0) {
    const prefix = message.slice(0, bodyStart).trim();
    try {
      const body: unknown = JSON.parse(message.slice(bodyStart));
      const errorValue = body && typeof body === "object" && "error" in body
        ? body.error
        : null;
      const errorBody = errorValue && typeof errorValue === "object"
        ? errorValue as Record<string, unknown>
        : null;
      const errorType = typeof errorBody?.type === "string" ? errorBody.type : null;
      const errorDetail = typeof errorBody?.message === "string" ? errorBody.message : null;
      message = [prefix, errorType, errorDetail].filter(Boolean).join(" ");
    } catch {
      message = prefix || "Apify provider returned an error.";
    }
  }
  return message
    .replace(/\bapify_api_[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization)["']?\s*[:=]\s*["']?)[^"',\s}&]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|key|secret|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b((?:external[_-]?)?(?:actor|dataset|run|request)[_-]?id)\s*[:=]\s*["']?[^"',\s}&]+/gi, "$1=[REDACTED]")
    .replace(/\b((?:query|search[_-]?term)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 300) || null;
}

function formatDiagnosticDate(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function aggregateSeedEconomics(rows: readonly SeedEconomicPerformance[]) {
  const total = (selector: (row: SeedEconomicPerformance) => number) => rows.reduce((sum, row) => sum + selector(row), 0);
  const providerCostUsd = total((row) => row.providerCostUsd);
  const newRaw = total((row) => row.newRaw);
  const duplicates = total((row) => row.duplicates);
  const attributedRows = rows.filter((row) => row.outcomeAttributionComplete);
  const attributedTotal = (selector: (row: SeedEconomicPerformance) => number | null) =>
    attributedRows.reduce((sum, row) => sum + (selector(row) ?? 0), 0);
  const outcomeTotal = (selector: (row: SeedEconomicPerformance) => number | null) =>
    rows.length > 0 && attributedRows.length === rows.length ? attributedTotal(selector) : null;
  const qualified = outcomeTotal((row) => row.qualifiedFromSeed);
  const website = outcomeTotal((row) => row.websiteFromSeed);
  const emailFound = outcomeTotal((row) => row.emailFoundFromSeed);
  const validEmail = outcomeTotal((row) => row.validEmailFromSeed);
  const imports = outcomeTotal((row) => row.confirmedInstantlyImportsFromSeed);
  return {
    outcomeAttributionCompleteSeeds: attributedRows.length,
    outcomeAttributionUnknownSeeds: rows.length - attributedRows.length,
    recentRuns: total((row) => row.recentRuns),
    sampleSize: total((row) => row.sampleSize),
    itemsReturned: total((row) => row.itemsReturned),
    newRaw,
    duplicates,
    noveltyRate: total((row) => row.itemsReturned) > 0 ? newRaw / total((row) => row.itemsReturned) : null,
    providerCostUsd,
    costPerNewRaw: newRaw > 0 ? providerCostUsd / newRaw : null,
    qualified,
    qualifiedYield: qualified !== null && newRaw > 0 ? qualified / newRaw : null,
    website,
    websiteRate: website !== null && newRaw > 0 ? website / newRaw : null,
    emailFound,
    emailFoundRate: emailFound !== null && newRaw > 0 ? emailFound / newRaw : null,
    validEmail,
    validEmailRate: validEmail !== null && newRaw > 0 ? validEmail / newRaw : null,
    instantlyImported: imports,
    instantlyImportRate: imports !== null && newRaw > 0 ? imports / newRaw : null,
    costPerConfirmedImport: imports !== null && imports > 0 ? providerCostUsd / imports : null,
  };
}

export async function GET() {
  try {
    const user = await requireCurrentUser();
    const workspaceId = await getCurrentWorkspaceId();
    const role = await getWorkspaceRole(workspaceId, user.userId);
    if (role !== "admin" && role !== "owner") {
      return NextResponse.json({ error: "Workspace admin authorization required." }, { status: 403 });
    }

    const db = getDb();
    const mapsEnv = getMapsEnv();
    const serperEnv = getSerperEnv();
    const diagnosticsNow = new Date();
    const [campaignRows, [settings], apifyRecovery, watchdogRows, discoveryRecoveryJobs, systemDiagnostics, serperRecovery, serperCostDiagnostics] = await Promise.all([
      listCampaigns(workspaceId),
      db.select({
        enabled: autopilotSettings.enabled,
        systemPaused: autopilotSettings.systemPaused,
        systemPauseReason: autopilotSettings.systemPauseReason,
        systemPausedAt: autopilotSettings.systemPausedAt,
        emergencyStopped: autopilotSettings.emergencyStopped,
        target: autopilotSettings.globalDailyTarget,
        targetMetric: autopilotSettings.targetMetric,
        timezone: autopilotSettings.timezone,
      }).from(autopilotSettings).where(eq(autopilotSettings.workspaceId, workspaceId)).limit(1),
      getApifyRecoverySnapshot(workspaceId),
      getWatchdogWorkspaceSignals(workspaceId),
      getRecoveryProbeDiscoveryJobs(workspaceId),
      getSystemHealthDiagnostics({
        workspaceId,
        now: diagnosticsNow,
        mapsDailyBudgetUsd: mapsEnv.APIFY_DAILY_COST_LIMIT_USD,
        serperDailyBudgetUsd: serperEnv.SERPER_DAILY_COST_LIMIT_USD,
      }),
      getSerperRecoveryState(diagnosticsNow),
      getSerperCostDiagnostics({
        dailyCapUsd: serperEnv.SERPER_DAILY_COST_LIMIT_USD,
        operatorProvidedBalanceUsd: serperEnv.SERPER_OPERATOR_BALANCE_USD,
        now: diagnosticsNow,
      }),
    ]);
    const watchdogSignals = watchdogRows[0] ?? null;
    const timeZone = settings?.timezone ?? "Europe/Madrid";
    const economicCampaigns = campaignRows.filter((campaign) => campaign.engineType === "maps_fast"
      || campaign.engineType === "maps_deep"
      || campaign.engineType === "google_serp"
      || campaign.engineType === "linkedin_owner");
    const [apifyDailyEconomics, pacing, seedEconomicsByCampaign] = await Promise.all([
      getApifyDailyEconomicTotals(workspaceId, timeZone, diagnosticsNow),
      getAutopilotPacingState(workspaceId, diagnosticsNow),
      Promise.all(economicCampaigns.map(async (campaign) => {
        const [seeds, economics] = await Promise.all([
          listSearchSeedsForCampaignEngine(campaign.id, campaign.engineType),
          getSeedEconomicPerformance(campaign.id, campaign.engineType, diagnosticsNow, campaign.timeZone),
        ]);
        return {
          campaignId: campaign.id,
          engineType: campaign.engineType,
          seeds: seeds.map((seed) => ({
          seed,
          performance: economics.get(seed.id),
          policy: scoreSeedEconomicPerformance(seed, economics.get(seed.id), diagnosticsNow),
          })),
        };
      })),
    ]);
    const seedEconomics = seedEconomicsByCampaign.flatMap((group) => group.seeds.map((item) => ({ ...item, campaignId: group.campaignId, engineType: group.engineType })));
    const campaignEconomics = seedEconomicsByCampaign.map((group) => ({
      campaignId: group.campaignId,
      engineType: group.engineType,
      ...aggregateSeedEconomics(group.seeds.flatMap((item) => item.performance ? [item.performance] : [])),
    }));
    const engineEconomics = [...new Set(campaignEconomics.map((row) => row.engineType))].map((engineType) => ({
      engineType,
      ...aggregateSeedEconomics(seedEconomicsByCampaign
        .filter((group) => group.engineType === engineType)
        .flatMap((group) => group.seeds.flatMap((item) => item.performance ? [item.performance] : []))),
    }));
    const googleSerpEconomics = engineEconomics.find((row) => row.engineType === "google_serp");
    const linkedinEconomics = engineEconomics.find((row) => row.engineType === "linkedin_owner");
    const mapsDeepEconomics = engineEconomics.find((row) => row.engineType === "maps_deep");
    const lowNoveltyCostTodayUsd = seedEconomics.reduce((total, item) =>
      total + (item.performance && item.performance.noveltyRate !== null && item.performance.noveltyRate < 0.1
        ? item.performance.providerCostTodayUsd
        : 0), 0);
    const duplicateResultRate = apifyDailyEconomics.accountedResultsReturned > 0
      ? apifyDailyEconomics.duplicates / apifyDailyEconomics.accountedResultsReturned
      : null;
    const costPerConfirmedImport = pacing.instantlyImportedToday > 0
      ? apifyDailyEconomics.spendUsd / pacing.instantlyImportedToday
      : null;
    const apifyHealth = buildProviderHealthSnapshot({
      provider: "apify",
      configured: mapsEnv.MAPS_PROVIDER === "apify" && Boolean(mapsEnv.APIFY_API_TOKEN),
      budgetAllowed: systemDiagnostics.providers.apify.budgetAllowed,
      usage: {
        calls: systemDiagnostics.providers.apify.recentTerminalCalls,
        errors: systemDiagnostics.providers.apify.recentErrors,
        items: 0,
        totalLatencyMs: 0,
        costUsd: 0,
        quotaRemaining: null,
      },
      recovery: apifyRecovery,
    });
    const serperAllocationUsage = await getRecentProviderUsage(workspaceId, "serper", 24, serperRecovery.recoveredAt);
    const serperAllocationHealth = serperRecovery.recoveryProbeEligible
      ? "untested"
      : serperRecovery.allocationPaused
        ? "paused"
        : evaluateProviderHealth(serperAllocationUsage);
    const serperHealth = buildProviderHealthSnapshot({
      provider: "serper",
      configured: serperEnv.SERP_PROVIDER === "serper" && Boolean(serperEnv.SERPER_API_KEY),
      budgetAllowed: serperCostDiagnostics.budgetRemainingUsd >= 0.001,
      allocationHealthOverride: serperAllocationHealth,
      usage: {
        calls: systemDiagnostics.providers.serper.recentTerminalCalls,
        errors: systemDiagnostics.providers.serper.recentErrors,
        items: 0,
        totalLatencyMs: 0,
        costUsd: 0,
        quotaRemaining: null,
      },
    });

    return NextResponse.json({
      currentUserId: user.userId,
      workspaceId,
      appEnv: process.env.APP_ENV ?? null,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      devSeedMode: (process.env.DEV_SEED_MODE ?? "true").trim().toLowerCase() === "true",
      ...getDatabaseIdentity(),
      campaigns: campaignRows.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        autopilotEnabled: campaign.autopilotEnabled,
        engineType: campaign.engineType,
        dailySoftTarget: campaign.dailySoftTarget,
      })),
      apify: {
        reliabilityHealth: apifyHealth.reliabilityHealth,
        allocationHealth: apifyHealth.allocationHealth,
        providerAvailable: apifyHealth.providerAvailable,
        recentTerminalCalls: apifyHealth.recentTerminalCalls,
        recentErrors: apifyHealth.recentErrors,
        recentErrorRate: apifyHealth.recentErrorRate,
        budgetAllowed: apifyHealth.budgetAllowed,
        recoveredAfterLatestFailure: apifyHealth.recoveredAfterLatestFailure,
        lastSuccessAt: systemDiagnostics.providers.apify.lastSuccessAt,
        lastFailureAt: systemDiagnostics.providers.apify.lastFailureAt,
        lastFailureClass: systemDiagnostics.providers.apify.lastFailureClass,
        recoveryProbeEligible: apifyRecovery.recoveryProbeEligible,
        recoveryProbeInFlight: apifyRecovery.recoveryProbeInFlight,
        nextRecoveryAttemptAt: formatDiagnosticDate(apifyRecovery.nextRecoveryAttemptAt),
        latestFailureKind: apifyRecovery.latestFailureKind,
        latestFailureAt: formatDiagnosticDate(apifyRecovery.latestFailureAt),
        credentialChangedSinceLatestFailure: apifyRecovery.credentialChangedSinceLatestFailure,
        latestFailureMessage: sanitizeApifyFailureMessage(apifyRecovery.latestFailureMessage),
        latestSuccessAt: formatDiagnosticDate(apifyRecovery.latestSuccessAt),
      },
      serper: {
        SERPER_PROVIDER_AVAILABLE: serperHealth.providerAvailable,
        SERPER_DAILY_CAP_USD: serperCostDiagnostics.dailyCapUsd,
        SERPER_SPEND_TODAY: serperCostDiagnostics.spendTodayUsd,
        SERPER_BUDGET_REMAINING: serperCostDiagnostics.budgetRemainingUsd,
        SERPER_PROJECTED_30D_SPEND: serperCostDiagnostics.rolling30DaySpendUsd,
        SERPER_PROJECTED_BALANCE_LIFETIME_DAYS: serperCostDiagnostics.projectedBalanceLifetimeDays,
        SERPER_OPERATOR_PROVIDED_BALANCE_USD: serperCostDiagnostics.operatorProvidedBalanceUsd,
        SERPER_PROJECTED_15D_MAX_SPEND: serperCostDiagnostics.projected15DayMaxSpendUsd,
        SERPER_PROJECTED_30D_MAX_SPEND: serperCostDiagnostics.projected30DayMaxSpendUsd,
        SERPER_ESTIMATED_BILLABLE_ATTEMPTS_TODAY: serperCostDiagnostics.estimatedBillableAttemptsToday,
        SERPER_ESTIMATED_MAX_DAILY_ATTEMPTS: serperCostDiagnostics.estimatedMaxDailyAttempts,
        SERPER_ALLOCATION_HEALTH: serperHealth.allocationHealth,
        SERPER_RELIABILITY_HEALTH: serperHealth.reliabilityHealth,
        SERPER_RECOVERY_PROBE_ELIGIBLE: serperRecovery.recoveryProbeEligible,
        SERPER_RECOVERY_PROBE_ATTEMPTED: (serperCostDiagnostics.purposes.recovery_probe?.queriesToday ?? 0) > 0,
        SERPER_RECOVERY_PROBE_SUCCEEDED: serperRecovery.recoveredAt !== null,
        SERPER_NEXT_RECOVERY_AT: formatDiagnosticDate(serperRecovery.nextRecoveryAttemptAt),
        GOOGLE_SERP_AVAILABLE: serperHealth.providerAvailable,
        MAPS_FAST_WEBSITE_RECOVERY_AVAILABLE: serperHealth.providerAvailable,
        MAPS_DEEP_SERPER_COMPONENT_AVAILABLE: serperHealth.providerAvailable,
        LINKEDIN_OWNER_AVAILABLE: serperHealth.providerAvailable,
        LINKEDIN_OWNER_ECONOMIC_PRIORITY: "exploration",
        LINKEDIN_OWNER_DAILY_SPEND_LIMIT_USD: Math.min(serperCostDiagnostics.dailyCapUsd * 0.05, SERPER_LINKEDIN_DAILY_EXPLORATION_LIMIT_USD),
        SERPER_GOOGLE_SERP_QUERIES: serperCostDiagnostics.purposes.google_serp_discovery?.queriesToday ?? 0,
        SERPER_GOOGLE_SERP_NEW_RAW: googleSerpEconomics?.newRaw ?? 0,
        SERPER_GOOGLE_SERP_VALID_EMAILS: googleSerpEconomics?.validEmail ?? null,
        SERPER_GOOGLE_SERP_IMPORTS: googleSerpEconomics?.instantlyImported ?? null,
        SERPER_GOOGLE_SERP_COST_PER_VALID_EMAIL: googleSerpEconomics?.validEmail && googleSerpEconomics.validEmail > 0
          ? googleSerpEconomics.providerCostUsd / googleSerpEconomics.validEmail
          : null,
        SERPER_GOOGLE_SERP_COST_PER_CONFIRMED_IMPORT: googleSerpEconomics?.costPerConfirmedImport ?? null,
        SERPER_GOOGLE_SERP_COST_TODAY: serperCostDiagnostics.purposes.google_serp_discovery?.spendTodayUsd ?? 0,
        SERPER_LINKEDIN_QUERIES: serperCostDiagnostics.purposes.linkedin_owner_discovery?.queriesToday ?? 0,
        SERPER_LINKEDIN_IMPORTS: linkedinEconomics?.instantlyImported ?? null,
        SERPER_LINKEDIN_COST_PER_CONFIRMED_IMPORT: linkedinEconomics?.costPerConfirmedImport ?? null,
        SERPER_LINKEDIN_COST_TODAY: serperCostDiagnostics.purposes.linkedin_owner_discovery?.spendTodayUsd ?? 0,
        SERPER_MAPS_RECOVERY_QUERIES: serperCostDiagnostics.purposes.maps_fast_website_recovery?.queriesToday ?? 0,
        SERPER_MAPS_RECOVERY_COST_TODAY: serperCostDiagnostics.purposes.maps_fast_website_recovery?.spendTodayUsd ?? 0,
        SERPER_MAPS_RECOVERY_ATTEMPTS_30D: serperCostDiagnostics.mapsFastRecovery.attempts,
        SERPER_MAPS_RECOVERED_WEBSITES_30D: serperCostDiagnostics.mapsFastRecovery.succeeded,
        SERPER_MAPS_RECOVERED_WITH_EMAIL_30D: serperCostDiagnostics.mapsFastRecovery.recoveredWithEmail,
        SERPER_MAPS_RECOVERED_VALID_EMAILS_30D: serperCostDiagnostics.mapsFastRecovery.recoveredValidEmails,
        SERPER_MAPS_RECOVERED_IMPORTS_30D: serperCostDiagnostics.mapsFastRecovery.recoveredImports,
        SERPER_COST_PER_RECOVERED_WEBSITE_30D: serperCostDiagnostics.mapsFastRecovery.costPerRecoveredWebsiteUsd,
        SERPER_COST_PER_VALID_EMAIL_30D: serperCostDiagnostics.mapsFastRecovery.costPerValidEmailUsd,
        SERPER_COST_PER_CONFIRMED_IMPORT_30D: serperCostDiagnostics.mapsFastRecovery.costPerConfirmedImportUsd,
        SERPER_MAPS_DEEP_QUERIES: serperCostDiagnostics.purposes.maps_deep_enrichment?.queriesToday ?? 0,
        SERPER_MAPS_DEEP_IMPORTS: mapsDeepEconomics?.instantlyImported ?? null,
        SERPER_MAPS_DEEP_COST_PER_CONFIRMED_IMPORT: mapsDeepEconomics?.costPerConfirmedImport ?? null,
        SERPER_MAPS_DEEP_COST_TODAY: serperCostDiagnostics.purposes.maps_deep_enrichment?.spendTodayUsd ?? 0,
        SERPER_RECOVERY_PROBE_QUERIES: serperCostDiagnostics.purposes.recovery_probe?.queriesToday ?? 0,
        SERPER_RECOVERY_PROBE_COST_TODAY: serperCostDiagnostics.purposes.recovery_probe?.spendTodayUsd ?? 0,
        reliabilityHealth: serperHealth.reliabilityHealth,
        allocationHealth: serperHealth.allocationHealth,
        providerAvailable: serperHealth.providerAvailable,
        recentTerminalCalls: serperHealth.recentTerminalCalls,
        recentErrors: serperHealth.recentErrors,
        recentErrorRate: serperHealth.recentErrorRate,
        budgetAllowed: serperHealth.budgetAllowed,
        lastSuccessAt: systemDiagnostics.providers.serper.lastSuccessAt,
        lastFailureAt: systemDiagnostics.providers.serper.lastFailureAt,
        lastFailureClass: systemDiagnostics.providers.serper.lastFailureClass,
        recoveryProbeEligible: serperRecovery.recoveryProbeEligible,
        nextRecoveryAttemptAt: formatDiagnosticDate(serperRecovery.nextRecoveryAttemptAt),
      },
      autopilot: settings ? {
        enabled: settings.enabled,
        systemPaused: settings.systemPaused,
        systemPauseReason: settings.systemPauseReason,
        systemPausedAt: formatDiagnosticDate(settings.systemPausedAt),
        emergencyStopped: settings.emergencyStopped,
        target: settings.target,
        targetMetric: settings.targetMetric,
      } : null,
      discoveryEconomics: {
        apifySpendTodayUsd: apifyDailyEconomics.spendUsd,
        apifyRunsToday: apifyDailyEconomics.runs,
        apifyResultsToday: apifyDailyEconomics.resultsReturned,
        newRawToday: apifyDailyEconomics.newRaw,
        duplicateExistingRawToday: apifyDailyEconomics.duplicates,
        duplicateResultRate,
        costPerNewRaw: apifyDailyEconomics.newRaw > 0 ? apifyDailyEconomics.spendUsd / apifyDailyEconomics.newRaw : null,
        qualifiedToday: pacing.qualifiedToday,
        validEmailToday: pacing.validEmailToday,
        instantlyImportedToday: pacing.instantlyImportedToday,
        costPerConfirmedImport,
        lowNoveltyCostTodayUsd,
        highNoveltySeedsAvailable: seedEconomics.filter((item) => item.performance?.noveltyRate !== null
          && item.performance?.noveltyRate !== undefined
          && (item.performance.recentRuns >= 3 || item.performance.sampleSize >= 50)
          && item.performance.noveltyRate >= 0.5 && item.policy.eligible).length,
        lowNoveltySeedsCooling: seedEconomics.filter((item) => item.performance?.zeroNoveltyRunStreak !== undefined
          && item.performance.zeroNoveltyRunStreak >= 2 && !item.policy.eligible).length,
        byCampaign: campaignEconomics,
        byEngine: engineEconomics,
        bySeed: seedEconomics.flatMap((item) => item.performance ? [{
          seedId: item.seed.id,
          campaignId: item.campaignId,
          engineType: item.engineType,
          sampleSize: item.performance.sampleSize,
          recentRuns: item.performance.recentRuns,
          noveltyRate: item.performance.noveltyRate,
          providerCostUsd: item.performance.providerCostUsd,
          costPerNewRaw: item.performance.costPerNewRaw,
          outcomeAttributionComplete: item.performance.outcomeAttributionComplete,
          qualifiedYield: item.performance.qualifiedYield,
          websiteRate: item.performance.websiteRate,
          emailFoundRate: item.performance.emailFoundRate,
          validEmailRate: item.performance.validEmailRate,
          instantlyImportRate: item.performance.instantlyImportRate,
          costPerConfirmedImport: item.performance.costPerConfirmedImport,
          tier: item.policy.tier,
          eligible: item.policy.eligible,
        }] : []),
      },
      watchdog: watchdogSignals ? {
        oldDueDiscoveryCount: watchdogSignals.oldDueDiscovery,
        oldProcessingCount: watchdogSignals.oldProcessing,
        staleDiscoveryLockCount: watchdogSignals.staleDiscoveryLocks,
        staleProcessingLockCount: watchdogSignals.staleProcessingLocks,
        oldestDueDiscoveryAgeMinutes: watchdogSignals.oldestDueDiscoveryAgeMinutes,
        oldestProcessingAgeMinutes: watchdogSignals.oldestProcessingAgeMinutes,
        pausePredicateMatched: getWatchdogPausePredicates(watchdogSignals),
        providerDeferredDiscoveryCount: watchdogSignals.deferredDiscovery,
        recoveryProbeDiscoveryCount: watchdogSignals.recoveryProbeDiscoveryCount,
      } : null,
      discoveryRecoveryJobs: discoveryRecoveryJobs.map((job) => ({
        id: job.id,
        campaignId: job.campaignId,
        engineType: job.engineType,
        origin: job.origin,
        desiredRawCount: job.desiredRawCount,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        createdAt: formatDiagnosticDate(job.createdAt),
        nextAttemptAt: formatDiagnosticDate(job.nextAttemptAt),
        lockedAt: formatDiagnosticDate(job.lockedAt),
        lockExpiresAt: formatDiagnosticDate(job.lockExpiresAt),
        providerDeferred: job.providerDeferred,
        lastErrorPresent: job.lastErrorPresent,
        ...(job.origin === "recovery_probe" ? sanitizeRecoveryJobError(job.lastError, job.sensitiveTerms) : {}),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    return NextResponse.json({ error: "Runtime diagnostics unavailable." }, { status: 500 });
  }
}