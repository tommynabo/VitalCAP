import { NextResponse } from "next/server";
import {
  getCoreEnv,
  getDatabaseEnv,
  getMapsEnv,
  getSerperEnv,
  getIntelligenceEnv,
  getVerificationEnv,
  getDeliveryEnv,
} from "@/lib/config/env";
import { getAuthEnv } from "@/lib/config/auth-env";
import { getRecentProviderUsage } from "@/infrastructure/neon/repositories/provider-runs";
import { getActiveAutopilotDiscoveryEngineTypes, getHealthWorkspaceIds } from "@/infrastructure/neon/repositories/diagnostics";
import { getSystemHealthDiagnostics, type SystemHealthDiagnostics } from "@/infrastructure/neon/repositories/health-diagnostics";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import type { EngineType } from "@/domain/campaigns/types";
import type { ProviderUsageStats } from "@/domain/providers/types";
import { emptyProviderUsageStats } from "@/domain/providers/types";
import { accumulateUsage, evaluateProviderHealth, hasUnavailableRequiredDiscoveryProvider } from "@/services/discovery/provider-health";

export const dynamic = "force-dynamic";

type HealthProviderStatus = ProviderHealthStatus | "missing_configuration";

type WorkspaceHealthSnapshot = {
  engineTypes: EngineType[];
  diagnostics: SystemHealthDiagnostics;
  mapsUsage: ProviderUsageStats;
  serpUsage: ProviderUsageStats;
};

const providerHealthSeverity: Record<HealthProviderStatus, number> = {
  missing_configuration: 6,
  paused: 5,
  degraded: 4,
  unknown: 3,
  untested: 2,
  healthy: 1,
};

function aggregateProviderHealth(statuses: HealthProviderStatus[]): HealthProviderStatus {
  if (statuses.length === 0) return "unknown";
  return statuses.reduce((worst, current) =>
    providerHealthSeverity[current] > providerHealthSeverity[worst] ? current : worst,
  );
}

function latestTimestamp(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function aggregateSystemDiagnostics(items: SystemHealthDiagnostics[]): SystemHealthDiagnostics {
  const aggregateProvider = (provider: "apify" | "serper") => {
    const values = items.map((item) => item.providers[provider]);
    const latestFailure = values
      .filter((value) => value.lastFailureAt !== null)
      .sort((left, right) => (left.lastFailureAt ?? "").localeCompare(right.lastFailureAt ?? ""))
      .at(-1);
    return {
      recentTerminalCalls: values.reduce((sum, value) => sum + value.recentTerminalCalls, 0),
      recentErrors: values.reduce((sum, value) => sum + value.recentErrors, 0),
      lastSuccessAt: latestTimestamp(values.map((value) => value.lastSuccessAt)),
      lastFailureAt: latestFailure?.lastFailureAt ?? null,
      lastFailureClass: latestFailure?.lastFailureClass ?? null,
      budgetAllowed: values.every((value) => value.budgetAllowed),
    };
  };
  const states = new Set(items.map((item) => item.autopilotEffectiveState));
  const autopilotEffectiveState: SystemHealthDiagnostics["autopilotEffectiveState"] = states.has("emergency_stopped")
    ? "emergency_stopped"
    : states.has("system_paused")
      ? "system_paused"
      : states.has("paused")
        ? "paused"
        : states.has("mixed") || states.size > 1
          ? "mixed"
          : states.has("running")
            ? "running"
            : "unknown";
  const pauseReasons = new Set(items.map((item) => item.systemPauseReason).filter((reason) => reason !== null));
  const queueTotal = (key: keyof SystemHealthDiagnostics["queue"]) =>
    items.reduce((sum, item) => sum + item.queue[key], 0);

  return {
    providers: { apify: aggregateProvider("apify"), serper: aggregateProvider("serper") },
    autopilotEffectiveState,
    systemPaused: items.some((item) => item.systemPaused),
    systemPauseReason: pauseReasons.size > 1 ? "mixed" : [...pauseReasons][0] ?? null,
    queue: {
      duePendingDiscovery: queueTotal("duePendingDiscovery"),
      deferredDiscovery: queueTotal("deferredDiscovery"),
      discoveryProcessing: queueTotal("discoveryProcessing"),
      discoveryStaleLocks: queueTotal("discoveryStaleLocks"),
      processingPending: queueTotal("processingPending"),
      processingProcessing: queueTotal("processingProcessing"),
      processingStaleLocks: queueTotal("processingStaleLocks"),
      manualProviderReconciliations: queueTotal("manualProviderReconciliations"),
    },
  };
}

export async function GET() {
  let status: "ok" | "degraded" = "ok";
  
  let coreEnv: any = null;
  try { coreEnv = getCoreEnv(); } catch (e) { status = "degraded"; }

  let dbEnv: any = null;
  try { dbEnv = getDatabaseEnv(); } catch (e) { status = "degraded"; }

  let authEnv: any = null;
  try { authEnv = getAuthEnv(); } catch (e) { status = "degraded"; }

  let mapsEnv: any = null;
  try { mapsEnv = getMapsEnv(); } catch (e) { status = "degraded"; }

  let serpEnv: any = null;
  try { serpEnv = getSerperEnv(); } catch (e) { status = "degraded"; }

  let intelEnv: any = null;
  try { intelEnv = getIntelligenceEnv(); } catch (e) { status = "degraded"; }

  let verifyEnv: any = null;
  try { verifyEnv = getVerificationEnv(); } catch (e) { status = "degraded"; }

  let deliveryEnv: any = null;
  try { deliveryEnv = getDeliveryEnv(); } catch (e) { status = "degraded"; }

  const mapsProvider = mapsEnv?.MAPS_PROVIDER || process.env.MAPS_PROVIDER || "mock";
  const mapsConfigured = mapsProvider === "mock"
    || (mapsProvider === "apify" && Boolean(mapsEnv?.APIFY_API_TOKEN));
  const serpConfigured = serpEnv?.SERP_PROVIDER === "serper" && Boolean(serpEnv?.SERPER_API_KEY);
  let mapsHealth = mapsConfigured ? "untested" : "missing_configuration";
  let serpHealth = serpConfigured ? "untested" : "missing_configuration";
  let diagnostics: Awaited<ReturnType<typeof getSystemHealthDiagnostics>> | null = null;
  let healthWorkspaceCount = 0;
  let operationalWorkspaceCount = 0;
  let pausedOperationalWorkspaceCount = 0;
  if (dbEnv?.DATABASE_URL) {
    try {
      const workspaceIds = await getHealthWorkspaceIds(deliveryEnv?.INSTANTLY_CAMPAIGN_ID ?? "");
      healthWorkspaceCount = workspaceIds.length;
      const enginesByWorkspace = await Promise.all(workspaceIds.map(async (workspaceId) => ({
        engineTypes: await getActiveAutopilotDiscoveryEngineTypes(workspaceId),
        workspaceId,
      })));
      const operationalWorkspaces = enginesByWorkspace.filter(({ engineTypes }) => engineTypes.length > 0);
      operationalWorkspaceCount = operationalWorkspaces.length;
      if (operationalWorkspaces.length === 0) {
        status = "degraded";
        if (mapsConfigured) mapsHealth = "unknown";
        if (serpConfigured) serpHealth = "unknown";
      } else {
        const snapshots: WorkspaceHealthSnapshot[] = await Promise.all(operationalWorkspaces.map(async ({ engineTypes, workspaceId }) => {
          const [systemDiagnostics, mapsUsage, serpUsage] = await Promise.all([
            getSystemHealthDiagnostics({
              workspaceId,
              now: new Date(),
              mapsDailyBudgetUsd: mapsEnv?.APIFY_DAILY_COST_LIMIT_USD ?? 0,
              serperDailyBudgetUsd: serpEnv?.SERPER_DAILY_COST_LIMIT_USD ?? 0,
            }),
            getRecentProviderUsage(workspaceId, "apify"),
            getRecentProviderUsage(workspaceId, "serper"),
          ]);
          return { engineTypes, diagnostics: systemDiagnostics, mapsUsage, serpUsage };
        }));
        const workspaceDiagnostics = snapshots.map((snapshot) => snapshot.diagnostics);
        diagnostics = aggregateSystemDiagnostics(workspaceDiagnostics);
        pausedOperationalWorkspaceCount = workspaceDiagnostics.filter((item) =>
          item.systemPaused || item.autopilotEffectiveState === "system_paused" || item.autopilotEffectiveState === "paused",
        ).length;
        if (snapshots.some(({ engineTypes }) => hasUnavailableRequiredDiscoveryProvider(engineTypes, mapsConfigured, serpConfigured))) {
          status = "degraded";
        }
        if (mapsConfigured) {
          mapsHealth = aggregateProviderHealth(snapshots.map(({ mapsUsage }) => evaluateProviderHealth(mapsUsage)));
        }
        if (serpConfigured) {
          serpHealth = aggregateProviderHealth(snapshots.map(({ serpUsage }) => evaluateProviderHealth(serpUsage)));
        }
      }
    } catch {
      status = "degraded";
      if (mapsConfigured) mapsHealth = "unknown";
      if (serpConfigured) serpHealth = "unknown";
    }
  }

  const mapsBudgetAllowed = diagnostics?.providers.apify.budgetAllowed ?? true;
  const serpBudgetAllowed = diagnostics?.providers.serper.budgetAllowed ?? true;
  const mapsProviderAvailable = mapsConfigured && mapsBudgetAllowed && (mapsHealth === "healthy" || mapsHealth === "untested");
  const serpProviderAvailable = serpConfigured && serpBudgetAllowed && (serpHealth === "healthy" || serpHealth === "untested");
  if (mapsConfigured && (!mapsBudgetAllowed || !["healthy", "untested"].includes(mapsHealth))) status = "degraded";
  if (serpConfigured && (!serpBudgetAllowed || !["healthy", "untested"].includes(serpHealth))) status = "degraded";
  if (diagnostics && (
    diagnostics.systemPaused
    || diagnostics.autopilotEffectiveState !== "running"
    || diagnostics.queue.discoveryStaleLocks > 0
    || diagnostics.queue.processingStaleLocks > 0
    || diagnostics.queue.manualProviderReconciliations > 0
  )) status = "degraded";

  return NextResponse.json({
    status,
    healthWorkspaceCount,
    operationalWorkspaceCount,
    pausedOperationalWorkspaceCount,
    healthScope: operationalWorkspaceCount > 1 ? "multi_workspace" : "single_workspace",
    timestamp: new Date().toISOString(),
    appEnv: coreEnv?.APP_ENV || process.env.APP_ENV || "development",
    vercelEnv: coreEnv?.VERCEL_ENV || process.env.VERCEL_ENV || null,
    devSeedMode: coreEnv?.DEV_SEED_MODE ?? false,
    databaseConfigured: Boolean(dbEnv?.DATABASE_URL),
    auth: {
      configured: Boolean(authEnv?.NEON_AUTH_BASE_URL && authEnv?.NEON_AUTH_COOKIE_SECRET),
    },
    maps: {
      provider: mapsProvider,
      configured: mapsConfigured,
      health: mapsHealth,
      recentTerminalCalls: diagnostics?.providers.apify.recentTerminalCalls ?? 0,
      recentErrors: diagnostics?.providers.apify.recentErrors ?? 0,
      lastSuccessAt: diagnostics?.providers.apify.lastSuccessAt ?? null,
      lastFailureAt: diagnostics?.providers.apify.lastFailureAt ?? null,
      lastFailureClass: diagnostics?.providers.apify.lastFailureClass ?? null,
      budgetAllowed: mapsBudgetAllowed,
      providerAvailable: mapsProviderAvailable,
    },
    serp: {
      provider: serpEnv?.SERP_PROVIDER || process.env.SERP_PROVIDER || "disabled",
      configured: serpConfigured,
      health: serpHealth,
      status: serpHealth,
      recentTerminalCalls: diagnostics?.providers.serper.recentTerminalCalls ?? 0,
      recentErrors: diagnostics?.providers.serper.recentErrors ?? 0,
      lastSuccessAt: diagnostics?.providers.serper.lastSuccessAt ?? null,
      lastFailureAt: diagnostics?.providers.serper.lastFailureAt ?? null,
      lastFailureClass: diagnostics?.providers.serper.lastFailureClass ?? null,
      budgetAllowed: serpBudgetAllowed,
      providerAvailable: serpProviderAvailable,
    },
    autopilotEffectiveState: diagnostics?.autopilotEffectiveState ?? "unknown",
    systemPaused: diagnostics?.systemPaused ?? false,
    emergencyStopped: diagnostics?.autopilotEffectiveState === "emergency_stopped",
    systemPauseReason: diagnostics?.systemPauseReason ?? null,
    queue: diagnostics?.queue ?? {
      duePendingDiscovery: 0,
      deferredDiscovery: 0,
      discoveryProcessing: 0,
      discoveryStaleLocks: 0,
      processingPending: 0,
      processingProcessing: 0,
      processingStaleLocks: 0,
      manualProviderReconciliations: 0,
    },
    intelligence: {
      provider: intelEnv?.LLM_PROVIDER || process.env.LLM_PROVIDER || "disabled",
      configured: intelEnv?.LLM_PROVIDER === "openai" ? Boolean(intelEnv?.LLM_PROVIDER_API_KEY) : true,
    },
    verification: {
      provider: verifyEnv?.EMAIL_VERIFICATION_PROVIDER || process.env.EMAIL_VERIFICATION_PROVIDER || "disabled",
    },
    delivery: {
      mode: coreEnv?.DEFAULT_DELIVERY_MODE || process.env.DEFAULT_DELIVERY_MODE || "dry_run",
      provider: deliveryEnv?.EMAIL_DELIVERY_PROVIDER || process.env.EMAIL_DELIVERY_PROVIDER || "disabled",
    },
  });
}
