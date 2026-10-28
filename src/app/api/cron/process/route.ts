import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest, unauthorizedCronResponse, runCronRoute } from "../_lib/cron-http";
import {
  PROCESSING_CRON_TIME_BUDGET_MS,
  PROCESSING_MAX_JOBS_PER_TICK,
  runProcessingCronTick,
} from "@/infrastructure/jobs/runners/processing-runner";
import { getWatchdogWorkspaceSignals } from "@/infrastructure/neon/repositories/watchdog-signals";
import { getAdaptiveProcessingMaxJobs, getProcessingHealthState } from "@/services/autopilot/watchdog-pause-policy";
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
      let queueSignals = {
        oldDueDiscovery: 0,
        deferredDiscovery: 0,
        oldProcessing: 0,
        staleDiscoveryLocks: 0,
        staleProcessingLocks: 0,
        manualReconciliations: 0,
        processingPending: 0,
        processingCompletedRecent: 0,
        processingFailedRecent: 0,
        processingTimedOutRecent: 0,
        processingEnqueuedRecent: 0,
      };
      let signalAvailable = true;
      try {
        const workspaces = await getWatchdogWorkspaceSignals();
        queueSignals = workspaces.reduce((total, row) => ({
          oldDueDiscovery: total.oldDueDiscovery + row.oldDueDiscovery,
          deferredDiscovery: total.deferredDiscovery + row.deferredDiscovery,
          oldProcessing: total.oldProcessing + row.oldProcessing,
          staleDiscoveryLocks: total.staleDiscoveryLocks + row.staleDiscoveryLocks,
          staleProcessingLocks: total.staleProcessingLocks + row.staleProcessingLocks,
          manualReconciliations: total.manualReconciliations + row.manualReconciliations,
          processingPending: total.processingPending + (row.processingPending ?? 0),
          processingCompletedRecent: total.processingCompletedRecent + (row.processingCompletedRecent ?? 0),
          processingFailedRecent: total.processingFailedRecent + (row.processingFailedRecent ?? 0),
          processingTimedOutRecent: total.processingTimedOutRecent + (row.processingTimedOutRecent ?? 0),
          processingEnqueuedRecent: total.processingEnqueuedRecent + (row.processingEnqueuedRecent ?? 0),
        }), queueSignals);
      } catch {
        signalAvailable = false;
      }
      const adaptiveMaxJobs = signalAvailable
        ? getAdaptiveProcessingMaxJobs(queueSignals)
        : PROCESSING_MAX_JOBS_PER_TICK;
      const healthState = signalAvailable ? getProcessingHealthState(queueSignals) : "unknown";
      let result;
      try {
        result = await runProcessingCronTick(adaptiveMaxJobs, new Date(), {
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
        PROCESSING_PENDING: queueSignals.processingPending,
        PROCESSING_ADAPTIVE_MAX_JOBS: adaptiveMaxJobs,
        PROCESSING_COMPLETED_LAST_30M: queueSignals.processingCompletedRecent,
        PROCESSING_FAILURES_LAST_30M: queueSignals.processingFailedRecent,
        PROCESSING_DRAIN_RATE_PER_HOUR: queueSignals.processingCompletedRecent * 2,
        PROCESSING_HEALTH_STATE: healthState,
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
