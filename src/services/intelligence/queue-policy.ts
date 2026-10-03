const PROVIDER_UNAVAILABLE_DELAY_MS = 15 * 60_000;

export function deferUnavailableProvider(attemptCount: number, now: Date) {
  return {
    status: "pending" as const,
    attemptCount: Math.max(attemptCount - 1, 0),
    nextAttemptAt: new Date(now.getTime() + PROVIDER_UNAVAILABLE_DELAY_MS),
  };
}

export function deferExhaustedBudget(attemptCount: number, nextBudgetWindow: Date) {
  return {
    status: "budget_paused" as const,
    attemptCount: Math.max(attemptCount - 1, 0),
    nextAttemptAt: nextBudgetWindow,
  };
}

export function retryFailedJob(attemptCount: number, maxAttempts: number, now: Date) {
  const deadLetter = attemptCount >= maxAttempts;
  return {
    status: deadLetter ? "dead_letter" as const : "failed" as const,
    nextAttemptAt: deadLetter ? null : new Date(now.getTime() + Math.pow(2, attemptCount) * 60_000),
  };
}