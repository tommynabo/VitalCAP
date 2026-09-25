import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runWarmFollowupCronTick } from "@/infrastructure/jobs/runners/warm-followup-runner";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("warm-followup", async () => {
    const result = await runWarmFollowupCronTick();
    return { itemsProcessed: result.entered + result.paused + result.completed + result.dispatched };
  });
}
