import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";

export const dynamic = "force-dynamic";

const MAX_JOBS_PER_TICK = 10;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("process", async () => {
    const result = await runProcessingCronTick(MAX_JOBS_PER_TICK);
    return { itemsProcessed: result.jobsClaimed };
  });
}
