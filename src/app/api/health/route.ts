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
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getRecentProviderUsage } from "@/infrastructure/neon/repositories/provider-runs";
import { getActiveAutopilotDiscoveryEngineTypes } from "@/infrastructure/neon/repositories/diagnostics";
import { getSystemHealthDiagnostics } from "@/infrastructure/neon/repositories/health-diagnostics";
import { emptyProviderUsageStats } from "@/domain/providers/types";
import { accumulateUsage, evaluateProviderHealth, hasUnavailableRequiredDiscoveryProvider } from "@/services/discovery/provider-health";

export const dynamic = "force-dynamic";

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
  if (dbEnv?.DATABASE_URL) {
    try {
      const [workspaceIds, engineTypes, systemDiagnostics] = await Promise.all([
        listWorkspaceIds(),
        getActiveAutopilotDiscoveryEngineTypes(),
        getSystemHealthDiagnostics({
          now: new Date(),
          mapsDailyBudgetUsd: mapsEnv?.APIFY_DAILY_COST_LIMIT_USD ?? 0,
          serperDailyBudgetUsd: serpEnv?.SERPER_DAILY_COST_LIMIT_USD ?? 0,
        }),
      ]);
      diagnostics = systemDiagnostics;
      if (hasUnavailableRequiredDiscoveryProvider(engineTypes, mapsConfigured, serpConfigured)) status = "degraded";
      const [mapsUsages, serpUsages] = await Promise.all([
        Promise.all(workspaceIds.map((workspaceId) => getRecentProviderUsage(workspaceId, "apify"))),
        Promise.all(workspaceIds.map((workspaceId) => getRecentProviderUsage(workspaceId, "serper"))),
      ]);
      if (mapsConfigured) mapsHealth = evaluateProviderHealth(mapsUsages.reduce(accumulateUsage, emptyProviderUsageStats()));
      if (serpConfigured) {
        const usage = serpUsages.reduce(accumulateUsage, emptyProviderUsageStats());
        serpHealth = evaluateProviderHealth(usage);
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
  if (mapsConfigured && (!mapsBudgetAllowed || mapsHealth === "paused")) status = "degraded";
  if (serpConfigured && (!serpBudgetAllowed || serpHealth === "paused")) status = "degraded";

  return NextResponse.json({
    status,
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
    systemPauseReason: diagnostics?.systemPauseReason ?? null,
    queue: diagnostics?.queue ?? {
      duePendingDiscovery: 0,
      deferredDiscovery: 0,
      processingPending: 0,
      staleLocks: 0,
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
