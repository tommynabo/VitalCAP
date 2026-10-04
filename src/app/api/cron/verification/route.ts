import type { NextRequest } from "next/server";
import { runVerificationCronTick, enqueueVerificationJobs } from "@/infrastructure/jobs/runners/verification-runner";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("verification", async () => {
    const enqueued = await enqueueVerificationJobs();
    const result = await runVerificationCronTick(50, {
      createdSince: new Date(Date.now() - 48 * 60 * 60_000),
    });
    const backfillRequested = request.nextUrl.searchParams.get("backfill") === "48h";
    return {
      itemsProcessed: result.jobsClaimed,
      metadata: {
        enqueued,
        jobsClaimed: result.jobsClaimed,
        emailsVerified: result.emailsVerified,
        millionVerifierStatus: result.millionVerifierStatus,
        instantly: result.instantly,
        ...(backfillRequested ? { backfillWindowHours: 48 } : {}),
      },
    };
  });
}
