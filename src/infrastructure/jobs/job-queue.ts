import type { JobRecord } from "@/domain/discovery/types";

/**
 * Durable job runner primitives (Prompt 2 §2.12): atomic claim/lease,
 * exponential backoff for transient errors, dead-letter after
 * `maxAttempts`. Pure functions over `JobRecord[]` — no persistence here;
 * the actual atomic claim (e.g. a `SELECT ... FOR UPDATE SKIP LOCKED` or a
 * conditional `UPDATE ... WHERE status = 'pending'`) is a job for the real
 * Supabase-backed repository once Phase 1's migrations are applied. These
 * functions define the exact semantics that repository must implement, and
 * let that logic be unit-tested without a database.
 */

export interface ClaimOptions {
  leaseMs: number;
}

const DEFAULT_CLAIM_OPTIONS: ClaimOptions = { leaseMs: 5 * 60 * 1000 };

/** A job is claimable if pending-and-due, or if a previous lease expired without completion (crash recovery). */
function isClaimable<T>(job: JobRecord<T>, now: Date, leaseMs: number): boolean {
  if (job.status === "completed" || job.status === "dead_letter" || job.status === "failed") return false;
  if (job.nextAttemptAt && new Date(job.nextAttemptAt).getTime() > now.getTime()) return false;
  if (job.status === "pending") return true;
  if (job.status === "processing" && job.lockedAt) {
    return new Date(job.lockedAt).getTime() + leaseMs <= now.getTime();
  }
  return false;
}

/**
 * Claims exactly one job for `workerId`, simulating an atomic
 * claim-or-skip: never returns a job another (non-expired) worker already
 * holds the lease on. Returns `null` if nothing is claimable right now.
 */
export function claimNextJob<T>(jobs: readonly JobRecord<T>[], workerId: string, now: Date, options: Partial<ClaimOptions> = {}): JobRecord<T> | null {
  const opts = { ...DEFAULT_CLAIM_OPTIONS, ...options };
  const candidate = jobs.find((job) => isClaimable(job, now, opts.leaseMs));
  if (!candidate) return null;

  return {
    ...candidate,
    status: "processing",
    lockedAt: now.toISOString(),
    lockedBy: workerId,
    attemptCount: candidate.attemptCount + 1,
    updatedAt: now.toISOString(),
  };
}

export function completeJob<T>(job: JobRecord<T>, now: Date): JobRecord<T> {
  return { ...job, status: "completed", lockedAt: null, lockedBy: null, nextAttemptAt: null, lastError: null, updatedAt: now.toISOString() };
}

/** Classifies whether an error is worth retrying. Permanent errors (bad input, 4xx-shaped) dead-letter immediately. */
export function isPermanentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid|not[_ ]?found|unauthorized|forbidden|bad[_ ]?request/i.test(message);
}

/** Exponential backoff with a cap, so a persistently-failing job doesn't retry forever in a tight loop. */
export function computeBackoffMs(attemptCount: number, baseMs = 30_000, maxMs = 60 * 60 * 1000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attemptCount - 1));
}

export interface FailJobOptions {
  maxAttempts?: number;
}

/**
 * Records a failed attempt. Permanent errors go straight to dead-letter
 * regardless of attempt count; transient errors retry with exponential
 * backoff until `maxAttempts` is reached, then dead-letter.
 */
export function failJob<T>(job: JobRecord<T>, error: unknown, now: Date, options: FailJobOptions = {}): JobRecord<T> {
  const maxAttempts = options.maxAttempts ?? job.maxAttempts;
  const message = error instanceof Error ? error.message : String(error);
  const permanent = isPermanentError(error);

  if (permanent || job.attemptCount >= maxAttempts) {
    return {
      ...job,
      status: "dead_letter",
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: null,
      lastError: message,
      updatedAt: now.toISOString(),
    };
  }

  const backoffMs = computeBackoffMs(job.attemptCount);
  return {
    ...job,
    status: "pending",
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: new Date(now.getTime() + backoffMs).toISOString(),
    lastError: message,
    updatedAt: now.toISOString(),
  };
}
