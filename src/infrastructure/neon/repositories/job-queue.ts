import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { deadLetterJobs } from "../schema/outreach";
import { discoveryJobs, processingJobs } from "../schema/discovery";
import type { JobRecord, JobStatus } from "@/domain/discovery/types";
import { computeBackoffMs, isPermanentError } from "@/infrastructure/jobs/job-queue";

/**
 * Durable Neon-backed job queue (Prompt 7 §24). Implements the exact same
 * semantics `src/infrastructure/jobs/job-queue.ts`'s pure functions define
 * (crash-recoverable lease claim, exponential backoff, dead-letter after
 * `maxAttempts`) but as atomic SQL against `discovery_jobs` /
 * `processing_jobs` instead of an in-memory array. Claim is a single
 * `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` statement — atomic
 * even over the Neon HTTP driver, which only ever sends one statement per
 * round trip (no explicit multi-statement transaction needed for a single
 * UPDATE). Campaign `status != 'active'` never gets claimed (pause prevents
 * claims, per §24).
 */

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

interface JobRow {
  id: string;
  campaign_id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toJobRecord<T>(row: JobRow): JobRecord<T> {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type: row.type,
    payload: row.payload as T,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function claimNext<T>(table: "discovery_jobs" | "processing_jobs", workerId: string, now: Date, leaseMs: number): Promise<JobRecord<T> | null> {
  const db = getDb();
  const nowIso = now.toISOString();
  const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));

  const result =
    table === "discovery_jobs"
      ? await db.execute(sql`
          UPDATE discovery_jobs AS job
          SET status = 'processing',
              locked_at = ${nowIso}::timestamptz,
              locked_by = ${workerId},
              attempt_count = job.attempt_count + 1,
              updated_at = ${nowIso}::timestamptz
          FROM (
            SELECT j.id
            FROM discovery_jobs j
            JOIN campaigns c ON c.id = j.campaign_id
            WHERE c.status = 'active'
              AND j.status IN ('pending', 'processing')
              AND j.next_attempt_at <= ${nowIso}::timestamptz
              AND (j.status = 'pending' OR j.locked_at + (${leaseSeconds} * interval '1 second') <= ${nowIso}::timestamptz)
            ORDER BY j.next_attempt_at ASC
            FOR UPDATE OF j SKIP LOCKED
            LIMIT 1
          ) AS claimed
          WHERE job.id = claimed.id
          RETURNING job.*;
        `)
      : await db.execute(sql`
          UPDATE processing_jobs AS job
          SET status = 'processing',
              locked_at = ${nowIso}::timestamptz,
              locked_by = ${workerId},
              attempt_count = job.attempt_count + 1,
              updated_at = ${nowIso}::timestamptz
          FROM (
            SELECT j.id
            FROM processing_jobs j
            JOIN campaigns c ON c.id = j.campaign_id
            WHERE c.status = 'active'
              AND j.status IN ('pending', 'processing')
              AND j.next_attempt_at <= ${nowIso}::timestamptz
              AND (j.status = 'pending' OR j.locked_at + (${leaseSeconds} * interval '1 second') <= ${nowIso}::timestamptz)
            ORDER BY j.next_attempt_at ASC
            FOR UPDATE OF j SKIP LOCKED
            LIMIT 1
          ) AS claimed
          WHERE job.id = claimed.id
          RETURNING job.*;
        `);

  const row = (result.rows[0] as JobRow | undefined) ?? undefined;
  return row ? toJobRecord<T>(row) : null;
}

export async function claimNextDiscoveryJob<T = Record<string, unknown>>(
  workerId: string,
  now: Date = new Date(),
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<JobRecord<T> | null> {
  return claimNext<T>("discovery_jobs", workerId, now, leaseMs);
}

export async function claimNextProcessingJob<T = Record<string, unknown>>(
  workerId: string,
  now: Date = new Date(),
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<JobRecord<T> | null> {
  return claimNext<T>("processing_jobs", workerId, now, leaseMs);
}

async function complete(table: "discovery_jobs" | "processing_jobs", jobId: string, now: Date): Promise<void> {
  const db = getDb();
  const nowIso = now.toISOString();
  if (table === "discovery_jobs") {
    await db.execute(sql`
      UPDATE discovery_jobs
      SET status = 'completed', locked_at = NULL, locked_by = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ${nowIso}::timestamptz
      WHERE id = ${jobId}::uuid;
    `);
  } else {
    await db.execute(sql`
      UPDATE processing_jobs
      SET status = 'completed', locked_at = NULL, locked_by = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ${nowIso}::timestamptz
      WHERE id = ${jobId}::uuid;
    `);
  }
}

export async function completeDiscoveryJob(jobId: string, now: Date = new Date()): Promise<void> {
  return complete("discovery_jobs", jobId, now);
}

export async function completeProcessingJob(jobId: string, now: Date = new Date()): Promise<void> {
  return complete("processing_jobs", jobId, now);
}

export interface FailJobOptions {
  maxAttempts?: number;
}

interface FailableJob {
  id: string;
  campaignId: string;
  type: string;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
}

async function fail(
  table: "discovery_jobs" | "processing_jobs",
  job: FailableJob,
  error: unknown,
  now: Date,
  options: FailJobOptions,
): Promise<void> {
  const db = getDb();
  const nowIso = now.toISOString();
  const maxAttempts = options.maxAttempts ?? job.maxAttempts;
  const message = error instanceof Error ? error.message : String(error);
  const permanent = isPermanentError(error);
  const deadLetter = permanent || job.attemptCount >= maxAttempts;

  if (deadLetter) {
    if (table === "discovery_jobs") {
      await db.execute(sql`
        UPDATE discovery_jobs
        SET status = 'dead_letter', locked_at = NULL, locked_by = NULL, next_attempt_at = NULL, last_error = ${message}, updated_at = ${nowIso}::timestamptz
        WHERE id = ${job.id}::uuid;
      `);
    } else {
      await db.execute(sql`
        UPDATE processing_jobs
        SET status = 'dead_letter', locked_at = NULL, locked_by = NULL, next_attempt_at = NULL, last_error = ${message}, updated_at = ${nowIso}::timestamptz
        WHERE id = ${job.id}::uuid;
      `);
    }
    await db.insert(deadLetterJobs).values({
      sourceTable: table,
      sourceJobId: job.id,
      campaignId: job.campaignId,
      payload: job.payload as Record<string, unknown>,
      attemptCount: job.attemptCount,
      lastError: message,
    });
    return;
  }

  const backoffMs = computeBackoffMs(job.attemptCount);
  const nextAttemptAtIso = new Date(now.getTime() + backoffMs).toISOString();
  if (table === "discovery_jobs") {
    await db.execute(sql`
      UPDATE discovery_jobs
      SET status = 'pending', locked_at = NULL, locked_by = NULL, next_attempt_at = ${nextAttemptAtIso}::timestamptz, last_error = ${message}, updated_at = ${nowIso}::timestamptz
      WHERE id = ${job.id}::uuid;
    `);
  } else {
    await db.execute(sql`
      UPDATE processing_jobs
      SET status = 'pending', locked_at = NULL, locked_by = NULL, next_attempt_at = ${nextAttemptAtIso}::timestamptz, last_error = ${message}, updated_at = ${nowIso}::timestamptz
      WHERE id = ${job.id}::uuid;
    `);
  }
}

export async function failDiscoveryJob(
  job: FailableJob,
  error: unknown,
  now: Date = new Date(),
  options: FailJobOptions = {},
): Promise<void> {
  return fail("discovery_jobs", job, error, now, options);
}

export async function failProcessingJob(
  job: FailableJob,
  error: unknown,
  now: Date = new Date(),
  options: FailJobOptions = {},
): Promise<void> {
  return fail("processing_jobs", job, error, now, options);
}

export interface EnqueueJobInput {
  campaignId: string;
  type: string;
  payload: Record<string, unknown>;
}

export async function enqueueDiscoveryJob(input: EnqueueJobInput): Promise<string> {
  const db = getDb();
  const [row] = await db.insert(discoveryJobs).values({ campaignId: input.campaignId, type: input.type, payload: input.payload }).returning({ id: discoveryJobs.id });
  if (!row) throw new Error("Failed to enqueue discovery job.");
  return row.id;
}

export async function enqueueProcessingJob(input: EnqueueJobInput): Promise<string> {
  const db = getDb();
  const [row] = await db.insert(processingJobs).values({ campaignId: input.campaignId, type: input.type, payload: input.payload }).returning({ id: processingJobs.id });
  if (!row) throw new Error("Failed to enqueue processing job.");
  return row.id;
}
