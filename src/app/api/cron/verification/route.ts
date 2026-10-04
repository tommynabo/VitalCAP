import type { NextRequest } from "next/server";
import { runVerificationCronTick, enqueueVerificationJobs } from "@/infrastructure/jobs/runners/verification-runner";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("verification", async () => {
    const backfillMode = request.nextUrl.searchParams.get("backfill");
    const backfillAll = backfillMode === "all";
    const instantlyBackfillAll = backfillMode !== "48h";
    const createdSince = new Date(Date.now() - 48 * 60 * 60_000);
    const enqueued = await enqueueVerificationJobs(backfillAll ? {} : { createdSince });
    const result = await runVerificationCronTick(50, {
      ...(instantlyBackfillAll ? { backfillAll: true } : { createdSince }),
    });
    return {
      itemsProcessed: result.jobsClaimed,
      metadata: {
        enqueued,
        jobsClaimed: result.jobsClaimed,
        emailsVerified: result.emailsVerified,
        millionVerifierStatus: result.millionVerifierStatus,
        instantly: result.instantly,
        ...(backfillAll
          ? {
              backfillMode: "all",
              backfillBatchLimit: 500,
              backfillMayContinue: enqueued === 500 || (result.instantly?.candidatesFound ?? 0) === 500,
            }
          : backfillMode === "48h"
            ? { backfillMode: "48h", backfillWindowHours: 48 }
            : { instantlyBackfillMode: "all", instantlyBackfillBatchLimit: 500 }),
      },
    };
  });
}
