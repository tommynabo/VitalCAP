import type { HistoricalBackfillPreview, HistoricalBackfillProgress, ProviderDisabledVerificationRepairResult } from "./verification-runner";
import type { VerificationRunnerResult } from "./verification-runner";
import type { InstantlyImportTickResult } from "./instantly-import-runner";

export interface HistoricalBackfillDrainDependencies {
  getProgress: () => Promise<HistoricalBackfillProgress>;
  getPreview: () => Promise<HistoricalBackfillPreview>;
  repairProviderDisabledJobs: () => Promise<ProviderDisabledVerificationRepairResult>;
  enqueueVerificationJobs: () => Promise<number>;
  runVerificationTick: (maxJobs: number, options: { backfillAll: true; skipInstantlyImport: true }) => Promise<VerificationRunnerResult>;
  runInstantlyTick: (options: { backfillAll: true }) => Promise<InstantlyImportTickResult>;
}

export interface HistoricalBackfillIteration {
  iteration: number;
  repairedJobs: ProviderDisabledVerificationRepairResult;
  verificationEnqueued: number;
  verification: VerificationRunnerResult;
  instantly: InstantlyImportTickResult;
  preview: HistoricalBackfillPreview;
  progress: HistoricalBackfillProgress;
  consecutiveNoProgress: number;
}

export interface HistoricalBackfillDrainResult {
  outcome: "complete" | "blocked";
  reason: string;
  iterations: HistoricalBackfillIteration[];
  progress: HistoricalBackfillProgress;
}

function isComplete(progress: HistoricalBackfillProgress): boolean {
  return progress.verificationCandidatesRemaining === 0
    && progress.verificationJobsPending === 0
    && progress.verificationJobsProcessing === 0
    && progress.verificationProviderDisabledJobs === 0
    && progress.eligibleValidContactsRemaining === 0
    && progress.instantlyImportJobsPending === 0;
}

function progressKey(progress: HistoricalBackfillProgress): string {
  return [
    progress.verificationCandidatesRemaining,
    progress.verificationJobsPending,
    progress.verificationJobsProcessing,
    progress.verificationProviderDisabledJobs,
    progress.eligibleValidContactsRemaining,
    progress.instantlyImportJobsPending,
  ].join(":");
}

function madeProgress(iteration: HistoricalBackfillIteration): boolean {
  return iteration.repairedJobs.resolvedFromCurrentResult > 0
    || iteration.repairedJobs.reactivated > 0
    || iteration.repairedJobs.suppressed > 0
    || iteration.verificationEnqueued > 0
    || iteration.verification.jobsClaimed > 0
    || iteration.verification.emailsVerified > 0
    || iteration.instantly.leadsQueued > 0
    || iteration.instantly.leadsAdded > 0
    || iteration.instantly.leadsSkipped > 0
    || (iteration.instantly.leadsNeedsReconciliation ?? 0) > 0
    || iteration.instantly.leadsDeferred > 0
    || iteration.instantly.leadsFailed > 0;
}

function terminalOutcomeBlocker(preview: HistoricalBackfillPreview, progress: HistoricalBackfillProgress): string | null {
  if (preview.instantlyDeferredDueToPlanLimit > 0 || progress.instantlyDeferredDueToPlanLimit > 0) {
    return "Instantly plan capacity is exhausted; leads remain deferred.";
  }
  if (preview.reconciliationRequired > 0) return "Instantly has ambiguous per-lead outcomes that require reconciliation.";
  if (preview.needsCampaignMove > 0) return "Some leads exist outside the target campaign and need an explicit campaign move.";
  if (preview.failedImports > 0) return "One or more Instantly imports exhausted retries and remain failed.";
  return null;
}

export async function drainHistoricalBackfill(
  dependencies: HistoricalBackfillDrainDependencies,
  options: { maxIterations?: number; batchSize?: number; onIteration?: (iteration: HistoricalBackfillIteration) => void } = {},
): Promise<HistoricalBackfillDrainResult> {
  const maxIterations = options.maxIterations ?? 500;
  const batchSize = options.batchSize ?? 50;
  const iterations: HistoricalBackfillIteration[] = [];
  let progress = await dependencies.getProgress();
  let currentPreview = await dependencies.getPreview();
  let noProgressPasses = 0;

  for (let iterationNumber = 1; iterationNumber <= maxIterations; iterationNumber++) {
    if (isComplete(progress)) {
      const blocker = terminalOutcomeBlocker(currentPreview, progress);
      if (blocker) return { outcome: "blocked", reason: blocker, iterations, progress };
      return { outcome: "complete", reason: "All eligible historical work reached a terminal state.", iterations, progress };
    }

    const beforeKey = progressKey(progress);
    const repairedJobs = await dependencies.repairProviderDisabledJobs();
    const verificationEnqueued = await dependencies.enqueueVerificationJobs();
    const verification = await dependencies.runVerificationTick(batchSize, { backfillAll: true, skipInstantlyImport: true });
    const instantly = await dependencies.runInstantlyTick({ backfillAll: true });
    const preview = await dependencies.getPreview();
    const nextProgress = await dependencies.getProgress();
    const pass: HistoricalBackfillIteration = {
      iteration: iterationNumber,
      repairedJobs,
      verificationEnqueued,
      verification,
      instantly,
      preview,
      progress: nextProgress,
      consecutiveNoProgress: 0,
    };

    if (progressKey(nextProgress) === beforeKey && !madeProgress(pass)) noProgressPasses++;
    else noProgressPasses = 0;
    pass.consecutiveNoProgress = noProgressPasses;
    iterations.push(pass);
    options.onIteration?.(pass);
    progress = nextProgress;

    if (isComplete(progress)) {
      const blocker = terminalOutcomeBlocker(preview, progress);
      if (blocker) return { outcome: "blocked", reason: blocker, iterations, progress };
      return { outcome: "complete", reason: "All eligible historical work reached a terminal state.", iterations, progress };
    }

    if (verification.millionVerifierStatus !== "ready" && progress.verificationCandidatesRemaining + progress.verificationJobsPending > 0) {
      return {
        outcome: "blocked",
        reason: `MillionVerifier is ${verification.millionVerifierStatus}; verification work remains.`,
        iterations,
        progress,
      };
    }
    if (instantly.providerStatus !== "ready" && (progress.eligibleValidContactsRemaining > 0 || progress.instantlyImportJobsPending > 0)) {
      return { outcome: "blocked", reason: `Instantly provider is ${instantly.providerStatus}; import work remains.`, iterations, progress };
    }
    const terminalBlocker = terminalOutcomeBlocker(preview, progress);
    if (terminalBlocker) return { outcome: "blocked", reason: terminalBlocker, iterations, progress };
    currentPreview = preview;
    if (noProgressPasses >= 2) {
      const blockers = [
        progress.verificationCandidatesRemaining > 0 ? "verification candidates" : null,
        progress.verificationJobsPending > 0 ? "verification jobs pending or waiting for retry backoff" : null,
        progress.verificationJobsProcessing > 0 ? "verification jobs held by active or expired leases" : null,
        progress.verificationProviderDisabledJobs > 0 ? "provider-disabled verification jobs" : null,
        progress.eligibleValidContactsRemaining > 0 ? "eligible verified contacts not imported" : null,
        progress.instantlyImportJobsPending > 0 ? "Instantly import jobs pending" : null,
      ].filter((value): value is string => value !== null);
      return { outcome: "blocked", reason: `No progress for two passes: ${blockers.join(", ")}.`, iterations, progress };
    }
  }

  return { outcome: "blocked", reason: `Maximum iteration limit (${maxIterations}) reached.`, iterations, progress };
}