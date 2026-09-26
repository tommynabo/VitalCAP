import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";

export const dynamic = "force-dynamic";

const MAX_JOBS_PER_TICK = 5;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("discovery", async () => {
    const result = await runDiscoveryCronTick(MAX_JOBS_PER_TICK);
    return {
      itemsProcessed: result.jobsClaimed,
      metadata: {
        state: result.emergencyStoppedWorkspaces > 0 ? "emergency_stopped" : result.pausedWorkspaces > 0 ? "paused" : "running",
        pausedWorkspaces: result.pausedWorkspaces,
        emergencyStoppedWorkspaces: result.emergencyStoppedWorkspaces,
      },
    };
  });
}
