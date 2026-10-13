import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { runInstantlyImportTick } from "@/infrastructure/jobs/runners/instantly-import-runner";
import { logEvent } from "@/lib/observability/structured-logger";
import { isAuthorizedCronRequest, runCronRoute, unauthorizedCronResponse } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  return runCronRoute("instantly-drain", async () => {
    const result = await runInstantlyImportTick({ processQueueOnly: true });
    logEvent("info", "cron.instantly-drain.completed", {
      correlationId: randomUUID(),
      provider: "instantly",
      outcome: result.providerStatus,
      candidatesFound: result.candidatesFound,
      leadsQueued: result.leadsQueued,
      leadsAttempted: result.leadsAttempted,
      leadsAdded: result.leadsAdded,
      leadsSkipped: result.leadsSkipped,
      leadsDeferred: result.leadsDeferred,
      leadsFailed: result.leadsFailed,
      leadsNeedsReconciliation: result.leadsNeedsReconciliation ?? 0,
      telemetryReady: result.instantlyTelemetryReady,
    });
    return {
      itemsProcessed: result.leadsAttempted,
      metadata: { instantly: result },
    };
  });
}