export const WATCHDOG_QUEUE_PAUSE_REASON = "Queue health deteriorated (watchdog)";
export const WATCHDOG_RECONCILIATION_PAUSE_REASON = "provider_reconciliation";

const WATCHDOG_OWNED_PAUSE_REASONS = new Set([
  WATCHDOG_QUEUE_PAUSE_REASON,
  WATCHDOG_RECONCILIATION_PAUSE_REASON,
]);

export interface WatchdogQueueSignals {
  oldDueDiscovery: number;
  deferredDiscovery: number;
  oldProcessing: number;
  staleDiscoveryLocks: number;
  staleProcessingLocks: number;
  manualReconciliations: number;
  processingPending?: number;
  processingCompletedRecent?: number;
  processingFailedRecent?: number;
  processingTimedOutRecent?: number;
  processingEnqueuedRecent?: number;
}

export type ProcessingHealthState = "healthy" | "healthy_draining" | "stalled";

export const PROCESSING_BASE_MAX_JOBS_PER_TICK = 8;
export const PROCESSING_HARD_MAX_JOBS_PER_TICK = 16;
const PROCESSING_REPEAT_FAILURE_THRESHOLD = 3;
const PROCESSING_REPEAT_TIMEOUT_THRESHOLD = 2;
const PROCESSING_UNCONTROLLED_GROWTH_THRESHOLD = 32;

export function getProcessingHealthState(signals: WatchdogQueueSignals): ProcessingHealthState {
  const pending = signals.processingPending ?? signals.oldProcessing;
  const completed = signals.processingCompletedRecent ?? 0;
  const failures = signals.processingFailedRecent ?? 0;
  const timeouts = signals.processingTimedOutRecent ?? 0;
  const enqueued = signals.processingEnqueuedRecent ?? 0;
  const queueGrowingUncontrollably = pending > 100
    && enqueued - completed >= PROCESSING_UNCONTROLLED_GROWTH_THRESHOLD;

  if (
    signals.staleProcessingLocks > 0
    || failures >= PROCESSING_REPEAT_FAILURE_THRESHOLD
    || timeouts >= PROCESSING_REPEAT_TIMEOUT_THRESHOLD
    || queueGrowingUncontrollably
    || (signals.oldProcessing > 0 && completed === 0)
  ) return "stalled";

  return pending > 50 || signals.oldProcessing > 0 ? "healthy_draining" : "healthy";
}

export function getAdaptiveProcessingMaxJobs(signals: WatchdogQueueSignals): number {
  const pending = signals.processingPending ?? signals.oldProcessing;
  if (
    getProcessingHealthState(signals) === "stalled"
    || pending <= 50
    || (signals.processingCompletedRecent ?? 0) <= 0
    || (signals.processingFailedRecent ?? 0) > 0
    || (signals.processingTimedOutRecent ?? 0) > 0
    || signals.staleProcessingLocks > 0
  ) return PROCESSING_BASE_MAX_JOBS_PER_TICK;
  return Math.min(
    pending <= 150 ? 12 : PROCESSING_HARD_MAX_JOBS_PER_TICK,
    PROCESSING_HARD_MAX_JOBS_PER_TICK,
  );
}

export function getDiscoveryBackpressureMultiplier(signals: WatchdogQueueSignals): number {
  if (getProcessingHealthState(signals) === "stalled") return 0;
  const pending = signals.processingPending ?? signals.oldProcessing;
  if (pending <= 50) return 1;
  if (pending <= 100) return 0.75;
  if (pending <= 150) return 0.5;
  return 0.25;
}

export interface WatchdogPauseState {
  systemPaused: boolean;
  systemPauseReason: string | null;
  systemPausedAt: Date | null;
}

export function getWatchdogPausePredicates(signals: WatchdogQueueSignals): string[] {
  const matched: string[] = [];
  if (signals.oldDueDiscovery > 0) matched.push("old_due_discovery");
  if (getProcessingHealthState(signals) === "stalled") matched.push("processing_stalled");
  if (signals.staleDiscoveryLocks > 0) matched.push("stale_discovery_lock");
  if (signals.staleProcessingLocks > 0) matched.push("stale_processing_lock");
  return matched;
}

export function isWatchdogQueuePauseResumeEligible(signals: WatchdogQueueSignals): boolean {
  const pending = signals.processingPending ?? signals.oldProcessing;
  const completed = signals.processingCompletedRecent ?? 0;
  const failures = signals.processingFailedRecent ?? 0;
  const timeouts = signals.processingTimedOutRecent ?? 0;
  const enqueued = signals.processingEnqueuedRecent ?? 0;
  const growingUncontrollably = pending > 100
    && enqueued - completed >= PROCESSING_UNCONTROLLED_GROWTH_THRESHOLD;

  return signals.oldDueDiscovery === 0
    && signals.staleDiscoveryLocks === 0
    && signals.staleProcessingLocks === 0
    && signals.manualReconciliations === 0
    && failures <= 1
    && timeouts === 0
    && !growingUncontrollably
    && (pending === 0 || completed > 0);
}

export function evaluateWatchdogPause(
  current: WatchdogPauseState,
  signals: WatchdogQueueSignals,
  now: Date,
): WatchdogPauseState {
  if (current.systemPaused && !WATCHDOG_OWNED_PAUSE_REASONS.has(current.systemPauseReason ?? "")) {
    return current;
  }

  const queueUnhealthy = getWatchdogPausePredicates(signals).length > 0;
  const queuePauseOwned = current.systemPaused && current.systemPauseReason === WATCHDOG_QUEUE_PAUSE_REASON;
  const queueRecovered = queuePauseOwned && isWatchdogQueuePauseResumeEligible(signals);
  const reason = signals.manualReconciliations > 0
    ? WATCHDOG_RECONCILIATION_PAUSE_REASON
    : queueUnhealthy && !queueRecovered
      ? WATCHDOG_QUEUE_PAUSE_REASON
      : null;

  return {
    systemPaused: reason !== null,
    systemPauseReason: reason,
    systemPausedAt: reason === null ? null : current.systemPausedAt ?? now,
  };
}