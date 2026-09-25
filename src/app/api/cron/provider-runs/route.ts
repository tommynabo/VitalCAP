import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runProviderRunsCronCheck } from "@/infrastructure/jobs/runners/provider-runs-runner";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("provider-runs", async () => {
    const result = await runProviderRunsCronCheck();
    return { itemsProcessed: result.workspacesChecked, warnings: result.warnings };
  });
}
