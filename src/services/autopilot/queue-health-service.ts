import type { JobRecord } from "@/domain/discovery/types";

/**
 * Queue health signals (Prompt 2 §2.12) derived purely from job records —
 * backlog depth, oldest-pending age, and jobs stuck in `processing` well
 * past a reasonable lease, which usually means a worker crashed without
 * releasing its lock.
 */

export interface QueueHealthOptions {
  staleProcessingMs: number;
  maxHealthyOldestPendingMs: number;
}

const DEFAULT_OPTIONS: QueueHealthOptions = {
  staleProcessingMs: 10 * 60 * 1000,
  maxHealthyOldestPendingMs: 30 * 60 * 1000,
};

export interface QueueHealthSnapshot {
  pendingCount: number;
  processingCount: number;
  deadLetterCount: number;
  oldestPendingAgeMs: number | null;
  stuckProcessingCount: number;
  healthy: boolean;
}

export function evaluateQueueHealth(jobs: readonly JobRecord[], now: Date, options: Partial<QueueHealthOptions> = {}): QueueHealthSnapshot {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const pending = jobs.filter((job) => job.status === "pending");
  const processing = jobs.filter((job) => job.status === "processing");
  const deadLetter = jobs.filter((job) => job.status === "dead_letter");

  const oldestPendingAgeMs = pending.length
    ? Math.max(...pending.map((job) => now.getTime() - new Date(job.createdAt).getTime()))
    : null;

  const stuckProcessingCount = processing.filter(
    (job) => job.lockedAt && now.getTime() - new Date(job.lockedAt).getTime() > opts.staleProcessingMs,
  ).length;

  const healthy = stuckProcessingCount === 0 && (oldestPendingAgeMs === null || oldestPendingAgeMs <= opts.maxHealthyOldestPendingMs);

  return {
    pendingCount: pending.length,
    processingCount: processing.length,
    deadLetterCount: deadLetter.length,
    oldestPendingAgeMs,
    stuckProcessingCount,
    healthy,
  };
}
