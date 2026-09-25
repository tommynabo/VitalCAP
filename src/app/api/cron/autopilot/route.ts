import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runAutopilotCronTick } from "@/infrastructure/jobs/runners/autopilot-runner";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("autopilot", async () => {
    const result = await runAutopilotCronTick();
    return { itemsProcessed: result.campaignsTicked };
  });
}
