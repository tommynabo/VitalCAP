import type { NextRequest } from "next/server";
import { runInstantlyImportTick } from "@/infrastructure/jobs/runners/instantly-import-runner";
import { isAuthorizedCronRequest, runCronRoute, unauthorizedCronResponse } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  return runCronRoute("instantly-drain", async () => {
    const result = await runInstantlyImportTick({ processQueueOnly: true });
    return {
      itemsProcessed: result.leadsAttempted,
      metadata: { instantly: result },
    };
  });
}