import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import {
  PROCESSING_CRON_TIME_BUDGET_MS,
  PROCESSING_MAX_JOBS_PER_TICK,
  runProcessingCronTick,
} from "@/infrastructure/jobs/runners/processing-runner";
import {
  createProcessingCronDiagnosticsContext,
  logProcessingCronFailure,
  runProcessingCronStage,
} from "@/infrastructure/jobs/runners/processing-cron-diagnostics";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const diagnostics = createProcessingCronDiagnosticsContext(randomUUID());
  let authorized: boolean;
  try {
    authorized = await runProcessingCronStage(diagnostics, "PROCESS_AUTH", () => isAuthorizedCronRequest(request));
  } catch {
    return NextResponse.json({ status: "failed" }, { status: 500 });
  }
  if (!authorized) return unauthorizedCronResponse();

  let processingWorkFailed = false;
  try {
    const response = await runProcessingCronStage(diagnostics, "CRON_RUN_PERSISTENCE", () => runCronRoute("process", async () => {
      let result;
      try {
        result = await runProcessingCronTick(PROCESSING_MAX_JOBS_PER_TICK, new Date(), {
          timeBudgetMs: PROCESSING_CRON_TIME_BUDGET_MS,
          correlationId: diagnostics.correlationId,
        });
      } catch (error) {
        processingWorkFailed = true;
        throw error;
      }
      const metadata = {
        jobsClaimed: result.jobsClaimed,
        jobsCompleted: result.jobsCompleted,
        jobsTimedOut: result.jobsTimedOut,
        cleanupFailures: result.cleanupFailures,
        durationMs: result.durationMs,
        RECOVERY_CANDIDATES_FOUND: result.recoveryCandidatesFound,
        RECOVERY_JOBS_ENQUEUED: result.recoveryJobsEnqueued,
        NORMAL_PROCESSING_JOBS_CLAIMED: result.jobsClaimed,
      };
      console.info("PROCESSING_CRON_RESULT", metadata);
      return { itemsProcessed: result.jobsClaimed, metadata };
    }));

    if (response.status >= 500) {
      if (!processingWorkFailed) logProcessingCronFailure(diagnostics, "CRON_RUN_PERSISTENCE");
      return NextResponse.json({ status: "failed" }, { status: response.status });
    }
    return response;
  } catch {
    return NextResponse.json({ status: "failed" }, { status: 500 });
  }
}
