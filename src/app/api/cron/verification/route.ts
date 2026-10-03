import type { NextRequest } from "next/server";
import { runVerificationCronTick, enqueueVerificationJobs } from "@/infrastructure/jobs/runners/verification-runner";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return runCronRoute("verification", async () => {
    const enqueued = await enqueueVerificationJobs();
    const result = await runVerificationCronTick(50);
    return {
      itemsProcessed: result.jobsClaimed,
      metadata: { enqueued, jobsClaimed: result.jobsClaimed, emailsVerified: result.emailsVerified },
    };
  });
}
