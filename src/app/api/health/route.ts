import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/config/env";

export function GET() {
  const env = getServerEnv();

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    appEnv: env.APP_ENV,
    vercelEnv: env.VERCEL_ENV ?? null,
    devSeedMode: env.DEV_SEED_MODE,
    databaseConfigured: Boolean(env.DATABASE_URL),
    authConfigured: Boolean(env.NEON_AUTH_BASE_URL && env.NEON_AUTH_COOKIE_SECRET && env.NEON_AUTH_COOKIE_SECRET.length >= 32),
    mapsProvider: env.MAPS_PROVIDER,
    apifyConfigured: Boolean(env.APIFY_API_TOKEN),
    deliveryMode: env.DEFAULT_DELIVERY_MODE,
  });
}
