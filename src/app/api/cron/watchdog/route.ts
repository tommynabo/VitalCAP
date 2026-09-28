import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runWatchdogCronTick } from "@/infrastructure/jobs/runners/watchdog-runner";
import { runProviderRunsCronCheck } from "@/infrastructure/jobs/runners/provider-runs-runner";

export const maxDuration = 60; // 1 minute is plenty for DB sweeps
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("watchdog", async () => {
    // 1. Run the auto-healing sweeps
    const watchdogResult = await runWatchdogCronTick();
    
    // 2. Run the provider health/cost checks
    const providerCheckResult = await runProviderRunsCronCheck();

    return {
      itemsProcessed: 1,
      metadata: {
        watchdogResult,
        providerCheckResult
      },
    };
  });
}
