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
}

export interface WatchdogPauseState {
  systemPaused: boolean;
  systemPauseReason: string | null;
  systemPausedAt: Date | null;
}

export function evaluateWatchdogPause(
  current: WatchdogPauseState,
  signals: WatchdogQueueSignals,
  now: Date,
): WatchdogPauseState {
  if (current.systemPaused && !WATCHDOG_OWNED_PAUSE_REASONS.has(current.systemPauseReason ?? "")) {
    return current;
  }

  const queueUnhealthy = signals.oldDueDiscovery > 0
    || signals.oldProcessing > 0
    || signals.staleDiscoveryLocks > 0
    || signals.staleProcessingLocks > 0;
  const reason = signals.manualReconciliations > 0
    ? WATCHDOG_RECONCILIATION_PAUSE_REASON
    : queueUnhealthy
      ? WATCHDOG_QUEUE_PAUSE_REASON
      : null;

  return {
    systemPaused: reason !== null,
    systemPauseReason: reason,
    systemPausedAt: reason === null ? null : current.systemPausedAt ?? now,
  };
}