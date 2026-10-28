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
import { getApifyRecoverySnapshot, getRecentProviderUsage, getSerperRecoveryState } from "@/infrastructure/neon/repositories/provider-runs";
import { getActiveAutopilotDiscoveryEngineTypes, getHealthWorkspaceIds } from "@/infrastructure/neon/repositories/diagnostics";
import { getSystemHealthDiagnostics, type SystemHealthDiagnostics } from "@/infrastructure/neon/repositories/health-diagnostics";
import type { EngineType } from "@/domain/campaigns/types";
import type { ProviderHealthSnapshot } from "@/services/discovery/provider-health";
import { aggregateProviderHealthSnapshots, buildProviderHealthSnapshot, evaluateProviderHealth, hasUnavailableRequiredDiscoveryProvider } from "@/services/discovery/provider-health";

export const dynamic = "force-dynamic";

type WorkspaceHealthSnapshot = {
  engineTypes: EngineType[];
  diagnostics: SystemHealthDiagnostics;
  maps: ProviderHealthSnapshot;
  serper: ProviderHealthSnapshot;
};

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
  let mapsReliabilityHealth = mapsConfigured ? "untested" : "missing_configuration";
  let mapsAllocationHealth = mapsReliabilityHealth;
  let mapsProviderAvailable = mapsConfigured;
  let mapsRecentTerminalCalls = 0;
  let mapsRecentErrors = 0;
  let mapsRecentErrorRate = 0;
  let mapsRecoveredAfterLatestFailure = false;
  let serpReliabilityHealth = serpConfigured ? "untested" : "missing_configuration";
  let serpAllocationHealth = serpReliabilityHealth;
  let serpProviderAvailable = serpConfigured;
  let serpRecentTerminalCalls = 0;
  let serpRecentErrors = 0;
  let serpRecentErrorRate = 0;
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
        if (mapsConfigured) mapsReliabilityHealth = mapsAllocationHealth = "unknown";
        if (serpConfigured) serpReliabilityHealth = serpAllocationHealth = "unknown";
        mapsProviderAvailable = false;
        serpProviderAvailable = false;
      } else {
        const snapshots: WorkspaceHealthSnapshot[] = await Promise.all(operationalWorkspaces.map(async ({ engineTypes, workspaceId }) => {
          const now = new Date();
          const [systemDiagnostics, apifyRecovery, serperRecovery] = await Promise.all([
            getSystemHealthDiagnostics({
              workspaceId,
              now,
              mapsDailyBudgetUsd: mapsEnv?.APIFY_DAILY_COST_LIMIT_USD ?? 0,
              serperDailyBudgetUsd: serpEnv?.SERPER_DAILY_COST_LIMIT_USD ?? 0,
            }),
            mapsProvider === "apify" ? getApifyRecoverySnapshot(workspaceId) : Promise.resolve(null),
            serpConfigured ? getSerperRecoveryState(now) : Promise.resolve(null),
          ]);
          const mapsUsage = {
            calls: systemDiagnostics.providers.apify.recentTerminalCalls,
            errors: systemDiagnostics.providers.apify.recentErrors,
            items: 0,
            totalLatencyMs: 0,
            costUsd: 0,
            quotaRemaining: null,
          };
          const serperUsage = {
            calls: systemDiagnostics.providers.serper.recentTerminalCalls,
            errors: systemDiagnostics.providers.serper.recentErrors,
            items: 0,
            totalLatencyMs: 0,
            costUsd: 0,
            quotaRemaining: null,
          };
          const serperAllocationHealth = !serperRecovery
            ? undefined
            : serperRecovery.recoveryProbeEligible
              ? "untested"
              : serperRecovery.allocationPaused
                ? "paused"
                : evaluateProviderHealth(await getRecentProviderUsage(workspaceId, "serper", 24, serperRecovery.recoveredAt));
          return {
            engineTypes,
            diagnostics: systemDiagnostics,
            maps: buildProviderHealthSnapshot({
              provider: mapsProvider === "apify" ? "apify" : "serper",
              configured: mapsConfigured,
              budgetAllowed: mapsProvider !== "apify" || systemDiagnostics.providers.apify.budgetAllowed,
              usage: mapsUsage,
              ...(apifyRecovery ? { recovery: apifyRecovery } : {}),
            }),
            serper: buildProviderHealthSnapshot({
              provider: "serper",
              configured: serpConfigured,
              budgetAllowed: systemDiagnostics.providers.serper.budgetAllowed,
              usage: serperUsage,
              ...(serperAllocationHealth ? { allocationHealthOverride: serperAllocationHealth } : {}),
            }),
          };
        }));
        const workspaceDiagnostics = snapshots.map((snapshot) => snapshot.diagnostics);
        diagnostics = aggregateSystemDiagnostics(workspaceDiagnostics);
        const mapsSnapshot = aggregateProviderHealthSnapshots(snapshots.map((snapshot) => snapshot.maps));
        const serperSnapshot = aggregateProviderHealthSnapshots(snapshots.map((snapshot) => snapshot.serper));
        mapsReliabilityHealth = mapsSnapshot.reliabilityHealth;
        mapsAllocationHealth = mapsSnapshot.allocationHealth;
        mapsProviderAvailable = mapsSnapshot.providerAvailable;
        mapsRecentTerminalCalls = mapsSnapshot.recentTerminalCalls;
        mapsRecentErrors = mapsSnapshot.recentErrors;
        mapsRecentErrorRate = mapsSnapshot.recentErrorRate;
        mapsRecoveredAfterLatestFailure = mapsSnapshot.recoveredAfterLatestFailure;
        serpReliabilityHealth = serperSnapshot.reliabilityHealth;
        serpAllocationHealth = serperSnapshot.allocationHealth;
        serpProviderAvailable = serperSnapshot.providerAvailable;
        serpRecentTerminalCalls = serperSnapshot.recentTerminalCalls;
        serpRecentErrors = serperSnapshot.recentErrors;
        serpRecentErrorRate = serperSnapshot.recentErrorRate;
        pausedOperationalWorkspaceCount = workspaceDiagnostics.filter((item) =>
          item.systemPaused || item.autopilotEffectiveState === "system_paused" || item.autopilotEffectiveState === "paused",
        ).length;
        if (snapshots.some(({ engineTypes, maps, serper }) =>
          hasUnavailableRequiredDiscoveryProvider(engineTypes, maps.providerAvailable, serper.providerAvailable),
        )) {
          status = "degraded";
        }
      }
    } catch {
      status = "degraded";
      if (mapsConfigured) mapsReliabilityHealth = mapsAllocationHealth = "unknown";
      if (serpConfigured) serpReliabilityHealth = serpAllocationHealth = "unknown";
      mapsProviderAvailable = false;
      serpProviderAvailable = false;
    }
  }

  const mapsBudgetAllowed = diagnostics?.providers.apify.budgetAllowed ?? true;
  const serpBudgetAllowed = diagnostics?.providers.serper.budgetAllowed ?? true;
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
      health: mapsReliabilityHealth,
      reliabilityHealth: mapsReliabilityHealth,
      allocationHealth: mapsAllocationHealth,
      recentTerminalCalls: mapsRecentTerminalCalls,
      recentErrors: mapsRecentErrors,
      recentErrorRate: mapsRecentErrorRate,
      lastSuccessAt: diagnostics?.providers.apify.lastSuccessAt ?? null,
      lastFailureAt: diagnostics?.providers.apify.lastFailureAt ?? null,
      lastFailureClass: diagnostics?.providers.apify.lastFailureClass ?? null,
      budgetAllowed: mapsBudgetAllowed,
      providerAvailable: mapsProviderAvailable,
      recoveredAfterLatestFailure: mapsRecoveredAfterLatestFailure,
    },
    serp: {
      provider: serpEnv?.SERP_PROVIDER || process.env.SERP_PROVIDER || "disabled",
      configured: serpConfigured,
      health: serpReliabilityHealth,
      status: serpReliabilityHealth,
      reliabilityHealth: serpReliabilityHealth,
      allocationHealth: serpAllocationHealth,
      recentTerminalCalls: serpRecentTerminalCalls,
      recentErrors: serpRecentErrors,
      recentErrorRate: serpRecentErrorRate,
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
