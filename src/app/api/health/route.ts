import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/config/env";

export function GET() {
  const env = getServerEnv();

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: env.APP_ENV,
    devSeedMode: env.DEV_SEED_MODE,
  });
}
