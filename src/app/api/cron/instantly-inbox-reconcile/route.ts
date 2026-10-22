import type { NextRequest } from "next/server";
import { runInstantlyInboxReconcileTick } from "@/infrastructure/jobs/runners/instantly-inbox-reconcile-runner";
import { isAuthorizedCronRequest, runCronRoute, unauthorizedCronResponse } from "../_lib/cron-http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  return runCronRoute("instantly-inbox-reconcile", async () => {
    const result = await runInstantlyInboxReconcileTick();
    return {
      itemsProcessed: result.repliesFound,
      metadata: { instantlyInbox: result },
      ...(result.processingFailures > 0 ? { warnings: ["One or more replies could not be processed; the current provider page will be retried."] } : {}),
    };
  });
}
