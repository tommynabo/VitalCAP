import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runAutopilotCronTick } from "@/infrastructure/jobs/runners/autopilot-runner";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("autopilot", async () => {
    const result = await runAutopilotCronTick();
    const statuses = result.pacingStates.map((state) => state.status);
    const pacing = result.pacingStates[0];
    return {
      itemsProcessed: result.campaignsTicked,
      metadata: {
        state: result.emergencyStoppedWorkspaces > 0 ? "emergency_stopped" : result.pausedWorkspaces > 0 ? "paused" : statuses[0] ?? "paused",
        pausedWorkspaces: result.pausedWorkspaces,
        emergencyStoppedWorkspaces: result.emergencyStoppedWorkspaces,
        ordersScheduled: result.ordersScheduled,
        pacingStatuses: statuses,
        ...(pacing ? {
          dailyTarget: pacing.dailyTarget,
          targetAchievedToday: pacing.targetAchievedToday,
          expectedAchievedByNow: pacing.expectedAchievedByNow,
          paceDeficit: pacing.paceDeficit,
          rawNeededToPlan: pacing.rawNeededToPlan,
          rawRequestsRemaining: pacing.rawRequestsRemaining,
          providerHealth: pacing.providerHealth,
          eligibleImportBacklog: pacing.eligibleImportBacklog,
          verificationInFlight: pacing.verificationInFlight,
          processingInFlight: pacing.processingInFlight,
          providerRunsInFlight: pacing.providerRunsInFlight,
        } : {}),
      },
    };
  });
}
