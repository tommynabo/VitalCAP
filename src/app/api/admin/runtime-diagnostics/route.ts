import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/infrastructure/neon/db";
import { listCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { autopilotSettings } from "@/infrastructure/neon/schema/autopilot";
import { getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";
import { getApifyRecoverySnapshot } from "@/infrastructure/neon/repositories/provider-runs";
import { getSystemHealthDiagnostics } from "@/infrastructure/neon/repositories/health-diagnostics";
import { getRecoveryProbeDiscoveryJobs, getWatchdogWorkspaceSignals } from "@/infrastructure/neon/repositories/watchdog-signals";
import { getCurrentWorkspaceId, requireCurrentUser, UnauthorizedError } from "@/lib/auth/workspace";
import { getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { resolveNeonVar } from "@/lib/config/env-utils";
import { buildProviderHealthSnapshot } from "@/services/discovery/provider-health";
import { getWatchdogPausePredicates } from "@/services/autopilot/watchdog-pause-policy";
import { sanitizeRecoveryJobError } from "./sanitize-recovery-error";

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
    const [campaignRows, [settings], apifyRecovery, watchdogRows, discoveryRecoveryJobs, systemDiagnostics] = await Promise.all([
      listCampaigns(workspaceId),
      db.select({
        enabled: autopilotSettings.enabled,
        systemPaused: autopilotSettings.systemPaused,
        systemPauseReason: autopilotSettings.systemPauseReason,
        systemPausedAt: autopilotSettings.systemPausedAt,
        emergencyStopped: autopilotSettings.emergencyStopped,
        target: autopilotSettings.globalDailyTarget,
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
    ]);
    const watchdogSignals = watchdogRows[0] ?? null;
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
    const serperHealth = buildProviderHealthSnapshot({
      provider: "serper",
      configured: serperEnv.SERP_PROVIDER === "serper" && Boolean(serperEnv.SERPER_API_KEY),
      budgetAllowed: systemDiagnostics.providers.serper.budgetAllowed,
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
        latestFailureMessage: sanitizeApifyFailureMessage(apifyRecovery.latestFailureMessage),
        latestSuccessAt: formatDiagnosticDate(apifyRecovery.latestSuccessAt),
      },
      serper: {
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
      },
      autopilot: settings ? {
        enabled: settings.enabled,
        systemPaused: settings.systemPaused,
        systemPauseReason: settings.systemPauseReason,
        systemPausedAt: formatDiagnosticDate(settings.systemPausedAt),
        emergencyStopped: settings.emergencyStopped,
        target: settings.target,
      } : null,
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