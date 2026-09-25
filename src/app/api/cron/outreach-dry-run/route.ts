import type { NextRequest } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import { runOutreachDryRunCronTick } from "@/infrastructure/jobs/runners/outreach-dry-run-runner";

export const dynamic = "force-dynamic";

/**
 * NEVER enables live sending — `runOutreachDryRunCronTick` delegates to the
 * pure `runOutreachDryRunCycle`, which hardcodes `deliveryMode: "dry_run"`
 * on every queue item it produces. There is no configuration flag on this
 * route that can change that.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("outreach-dry-run", async () => {
    const result = await runOutreachDryRunCronTick();
    return { itemsProcessed: result.campaignsProcessed };
  });
}
