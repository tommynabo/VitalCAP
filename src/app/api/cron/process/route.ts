import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { PROCESSING_CRON_TIME_BUDGET_MS, runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";

export const dynamic = "force-dynamic";

const MAX_JOBS_PER_TICK = 3;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("process", async () => {
    const result = await runProcessingCronTick(MAX_JOBS_PER_TICK, new Date(), {
      timeBudgetMs: PROCESSING_CRON_TIME_BUDGET_MS,
    });
    console.info("PROCESSING_CRON_RESULT", result);
    return {
      itemsProcessed: result.jobsClaimed,
      metadata: {
        jobsClaimed: result.jobsClaimed,
        jobsCompleted: result.jobsCompleted,
        jobsTimedOut: result.jobsTimedOut,
        cleanupFailures: result.cleanupFailures,
        durationMs: result.durationMs,
      },
    };
  });
}
