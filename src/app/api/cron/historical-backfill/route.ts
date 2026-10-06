import type { NextRequest } from "next/server";
import {
  enqueueVerificationJobs,
  getHistoricalBackfillProgress,
  repairProviderDisabledVerificationJobs,
  runVerificationCronTick,
} from "@/infrastructure/jobs/runners/verification-runner";
import { isAuthorizedCronRequest, runCronRoute, unauthorizedCronResponse } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();

  return runCronRoute("historical-backfill", async () => {
    const providerDisabledRepair = await repairProviderDisabledVerificationJobs();
    const enqueued = await enqueueVerificationJobs({});
    const result = await runVerificationCronTick(50, { backfillAll: true });
    const backfillProgress = await getHistoricalBackfillProgress();

    return {
      itemsProcessed: result.jobsClaimed,
      metadata: {
        providerDisabledRepair,
        enqueued,
        jobsClaimed: result.jobsClaimed,
        emailsVerified: result.emailsVerified,
        verificationValid: result.verificationValid ?? 0,
        verificationInvalid: result.verificationInvalid ?? 0,
        verificationCatchAll: result.verificationCatchAll ?? 0,
        verificationRisky: result.verificationRisky ?? 0,
        millionVerifierStatus: result.millionVerifierStatus,
        instantly: result.instantly,
        backfillProgress,
        remainingHistorical: backfillProgress.verificationCandidatesRemaining
          + backfillProgress.verificationJobsPending
          + backfillProgress.verificationJobsProcessing
          + backfillProgress.verificationProviderDisabledJobs
          + backfillProgress.eligibleValidContactsRemaining
          + backfillProgress.instantlyImportJobsPending,
      },
    };
  });
}