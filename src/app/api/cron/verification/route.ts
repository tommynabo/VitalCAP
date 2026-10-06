import type { NextRequest } from "next/server";
import {
  runVerificationCronTick,
  enqueueVerificationJobs,
  getHistoricalBackfillProgress,
  repairProviderDisabledVerificationJobs,
} from "@/infrastructure/jobs/runners/verification-runner";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("verification", async () => {
    const backfillMode = request.nextUrl.searchParams.get("backfill");
    const backfillAll = backfillMode === "all";
    const createdSince = new Date(Date.now() - 48 * 60 * 60_000);
    const providerDisabledRepair = await repairProviderDisabledVerificationJobs();
    const enqueued = await enqueueVerificationJobs(backfillAll ? {} : { createdSince });
    const result = await runVerificationCronTick(50, {
      ...(backfillAll ? { backfillAll: true } : { createdSince }),
    });
    const backfillProgress = backfillAll ? await getHistoricalBackfillProgress() : null;
    return {
      itemsProcessed: result.jobsClaimed,
      metadata: {
        enqueued,
        providerDisabledRepair,
        jobsClaimed: result.jobsClaimed,
        emailsVerified: result.emailsVerified,
        millionVerifierStatus: result.millionVerifierStatus,
        instantly: result.instantly,
        ...(backfillProgress ? { backfillProgress } : {}),
        ...(backfillAll
          ? {
              backfillMode: "all",
              backfillBatchLimit: 500,
              backfillMayContinue: backfillProgress
                ? backfillProgress.verificationCandidatesRemaining > 0
                  || backfillProgress.verificationJobsPending > 0
                  || backfillProgress.eligibleValidContactsRemaining > 0
                  || backfillProgress.instantlyImportJobsPending > 0
                : enqueued === 500 || result.jobsClaimed === 50 || (result.instantly?.candidatesFound ?? 0) === 500,
              remainingHistorical: backfillProgress
                ? backfillProgress.verificationCandidatesRemaining
                  + backfillProgress.verificationJobsPending
                  + backfillProgress.eligibleValidContactsRemaining
                  + backfillProgress.instantlyImportJobsPending
                : null,
            }
          : backfillMode === "48h"
            ? { backfillMode: "48h", backfillWindowHours: 48 }
            : { backfillMode: "48h", backfillWindowHours: 48 }),
      },
    };
  });
}
