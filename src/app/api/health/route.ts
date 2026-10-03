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

  const mapsConfigured = mapsEnv?.MAPS_PROVIDER === "apify" && Boolean(mapsEnv?.APIFY_API_TOKEN);
  const serpConfigured = serpEnv?.SERP_PROVIDER === "serper" && Boolean(serpEnv?.SERPER_API_KEY);
  let serpHealth = serpConfigured ? "untested" : "missing_configuration";
  if (dbEnv?.DATABASE_URL) {
    try {
      const [workspaceIds, engineTypes] = await Promise.all([
        listWorkspaceIds(),
        getActiveAutopilotDiscoveryEngineTypes(),
      ]);
      if (hasUnavailableRequiredDiscoveryProvider(engineTypes, mapsConfigured, serpConfigured)) status = "degraded";
      if (serpConfigured) {
        const usages = await Promise.all(workspaceIds.map((workspaceId) => getRecentProviderUsage(workspaceId, "serper")));
        const usage = usages.reduce(accumulateUsage, emptyProviderUsageStats());
        serpHealth = evaluateProviderHealth(usage);
      }
    } catch {
      status = "degraded";
      if (serpConfigured) serpHealth = "unknown";
    }
  }

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
      provider: mapsEnv?.MAPS_PROVIDER || process.env.MAPS_PROVIDER || "mock",
      configured: mapsEnv?.MAPS_PROVIDER === "apify" ? Boolean(mapsEnv?.APIFY_API_TOKEN) : true,
    },
    serp: {
      provider: serpEnv?.SERP_PROVIDER || process.env.SERP_PROVIDER || "disabled",
      configured: serpConfigured,
      health: serpHealth,
      status: serpHealth,
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
