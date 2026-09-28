import { NextResponse } from "next/server";
import {
  getCoreEnv,
  getDatabaseEnv,
  getMapsEnv,
  getIntelligenceEnv,
  getVerificationEnv,
  getDeliveryEnv,
} from "@/lib/config/env";
import { getAuthEnv } from "@/lib/config/auth-env";

export function GET() {
  let status: "ok" | "degraded" = "ok";
  
  let coreEnv: any = null;
  try { coreEnv = getCoreEnv(); } catch (e) { status = "degraded"; }

  let dbEnv: any = null;
  try { dbEnv = getDatabaseEnv(); } catch (e) { status = "degraded"; }

  let authEnv: any = null;
  try { authEnv = getAuthEnv(); } catch (e) { status = "degraded"; }

  let mapsEnv: any = null;
  try { mapsEnv = getMapsEnv(); } catch (e) { status = "degraded"; }

  let intelEnv: any = null;
  try { intelEnv = getIntelligenceEnv(); } catch (e) { status = "degraded"; }

  let verifyEnv: any = null;
  try { verifyEnv = getVerificationEnv(); } catch (e) { status = "degraded"; }

  let deliveryEnv: any = null;
  try { deliveryEnv = getDeliveryEnv(); } catch (e) { status = "degraded"; }

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
