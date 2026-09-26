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
    mapsProvider: env.MAPS_PROVIDER,
    deliveryMode: env.DEFAULT_DELIVERY_MODE,
  });
}
