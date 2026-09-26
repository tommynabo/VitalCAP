import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runProviderRunsCronCheck, runProviderRunsCronTick } from "@/infrastructure/jobs/runners/provider-runs-runner";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("provider-runs", async () => {
    const [poll, audit] = await Promise.all([runProviderRunsCronTick(), runProviderRunsCronCheck()]);
    return { itemsProcessed: poll.candidatesInserted, runsChecked: poll.runsChecked, runsIngested: poll.runsIngested, warnings: [...poll.warnings, ...audit.warnings] };
  });
}
