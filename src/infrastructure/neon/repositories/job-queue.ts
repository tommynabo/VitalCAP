import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { discoveryJobs, processingJobs } from "../schema/discovery";
import { deadLetterJobs } from "../schema/outreach";
import type { JobRecord, JobStatus } from "@/domain/discovery/types";
import { computeBackoffMs, isPermanentError } from "@/infrastructure/jobs/job-queue";

export const JOB_LEASE_MS = 5 * 60 * 1000;
const MAX_CLAIM_BATCH_SIZE = 100;

type QueueTable = "discovery_jobs" | "processing_jobs";

export type JobFailureClassification = "transient" | "permanent";

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export class TransientJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientJobError";
  }
}

export class LostLeaseError extends Error {
  readonly queue: QueueTable;
  readonly jobId: string;
  readonly workerId: string;

  constructor(queue: QueueTable, jobId: string, workerId: string) {
    super(`Lost lease for ${queue} job ${jobId} (worker ${workerId}).`);
    this.name = "LostLeaseError";
    this.queue = queue;
    this.jobId = jobId;
    this.workerId = workerId;
  }
}

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
  idempotency_key: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface FailableJob {
  id: string;
  campaignId: string;
  type: string;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
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
    idempotencyKey: row.idempotency_key,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeBatchSize(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize <= 0) return 1;
  return Math.min(batchSize, MAX_CLAIM_BATCH_SIZE);
}

function classifyFailure(error: unknown, explicit?: JobFailureClassification): JobFailureClassification {
  if (explicit) return explicit;
  if (error instanceof PermanentJobError) return "permanent";
  if (error instanceof TransientJobError) return "transient";
  return isPermanentError(error) ? "permanent" : "transient";
}

async function claim<T>(
  table: QueueTable,
  workerId: string,
  now: Date,
  leaseMs: number,
  batchSize: number,
  campaignId?: string,
  requireAutopilot = true,
): Promise<JobRecord<T>[]> {
  const db = getDb();
  const nowIso = now.toISOString();
  const inputCampaignId = campaignId ?? null;
  const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));
  const boundedBatchSize = normalizeBatchSize(batchSize);

  const result =
    table === "discovery_jobs"
      ? await db.execute(sql`
          WITH claimable AS (
            SELECT j.id
            FROM discovery_jobs j
            JOIN campaigns c ON c.id = j.campaign_id
            LEFT JOIN autopilot_settings aps ON aps.workspace_id = c.workspace_id
            WHERE c.status = 'active'
              AND (${requireAutopilot} = false OR (c.autopilot_enabled = true AND aps.enabled = true AND aps.emergency_stopped = false))
              AND (${inputCampaignId}::uuid IS NULL OR j.campaign_id = ${inputCampaignId}::uuid)
              AND j.status IN ('pending', 'processing')
              AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ${nowIso}::timestamptz)
              AND (
                j.status = 'pending'
                OR j.locked_at IS NULL
                OR j.locked_at + (${leaseSeconds} * interval '1 second') <= ${nowIso}::timestamptz
              )
            ORDER BY j.next_attempt_at ASC NULLS FIRST
            FOR UPDATE OF j SKIP LOCKED
            LIMIT ${boundedBatchSize}
          )
          UPDATE discovery_jobs AS job
          SET status = 'processing',
              locked_at = ${nowIso}::timestamptz,
              locked_by = ${workerId},
              attempt_count = job.attempt_count + 1,
              updated_at = ${nowIso}::timestamptz
          FROM claimable
          WHERE job.id = claimable.id
          RETURNING job.*;
        `)
      : await db.execute(sql`
          WITH claimable AS (
            SELECT j.id
            FROM processing_jobs j
            JOIN campaigns c ON c.id = j.campaign_id
            LEFT JOIN autopilot_settings aps ON aps.workspace_id = c.workspace_id
            WHERE c.status = 'active'
              AND (${requireAutopilot} = false OR (c.autopilot_enabled = true AND aps.emergency_stopped = false))
              AND (${inputCampaignId}::uuid IS NULL OR j.campaign_id = ${inputCampaignId}::uuid)
              AND j.status IN ('pending', 'processing')
              AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ${nowIso}::timestamptz)
              AND (
                j.status = 'pending'
                OR j.locked_at IS NULL
                OR j.locked_at + (${leaseSeconds} * interval '1 second') <= ${nowIso}::timestamptz
              )
            ORDER BY j.next_attempt_at ASC NULLS FIRST
            FOR UPDATE OF j SKIP LOCKED
            LIMIT ${boundedBatchSize}
          )
          UPDATE processing_jobs AS job
          SET status = 'processing',
              locked_at = ${nowIso}::timestamptz,
              locked_by = ${workerId},
              attempt_count = job.attempt_count + 1,
              updated_at = ${nowIso}::timestamptz
          FROM claimable
          WHERE job.id = claimable.id
          RETURNING job.*;
        `);

  return (result.rows as unknown as JobRow[]).map((row) => toJobRecord<T>(row));
}

export interface ClaimJobsInput {
  workerId: string;
  batchSize: number;
  campaignId?: string;
  requireAutopilot?: boolean;
  now?: Date;
  leaseMs?: number;
}

export async function claimDiscoveryJobs<T = Record<string, unknown>>(input: ClaimJobsInput): Promise<JobRecord<T>[]> {
  return claim<T>("discovery_jobs", input.workerId, input.now ?? new Date(), input.leaseMs ?? JOB_LEASE_MS, input.batchSize, input.campaignId, input.requireAutopilot ?? true);
}

export async function claimProcessingJobs<T = Record<string, unknown>>(input: ClaimJobsInput): Promise<JobRecord<T>[]> {
  return claim<T>("processing_jobs", input.workerId, input.now ?? new Date(), input.leaseMs ?? JOB_LEASE_MS, input.batchSize, input.campaignId, input.requireAutopilot ?? true);
}

export async function claimNextDiscoveryJob<T = Record<string, unknown>>(
  workerId: string,
  now: Date = new Date(),
  leaseMs: number = JOB_LEASE_MS,
): Promise<JobRecord<T> | null> {
  const jobs = await claimDiscoveryJobs<T>({ workerId, batchSize: 1, now, leaseMs });
  return jobs[0] ?? null;
}

export async function claimNextProcessingJob<T = Record<string, unknown>>(
  workerId: string,
  now: Date = new Date(),
  leaseMs: number = JOB_LEASE_MS,
): Promise<JobRecord<T> | null> {
  const jobs = await claimProcessingJobs<T>({ workerId, batchSize: 1, now, leaseMs });
  return jobs[0] ?? null;
}

export interface CompleteJobInput {
  jobId: string;
  workerId: string;
  now?: Date;
}

async function complete(table: QueueTable, input: CompleteJobInput): Promise<void> {
  const db = getDb();
  const nowIso = (input.now ?? new Date()).toISOString();

  const result =
    table === "discovery_jobs"
      ? await db.execute(sql`
          UPDATE discovery_jobs
          SET status = 'completed',
              locked_at = NULL,
              locked_by = NULL,
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = ${nowIso}::timestamptz
          WHERE id = ${input.jobId}::uuid
            AND status = 'processing'
            AND locked_by = ${input.workerId}
          RETURNING id;
        `)
      : await db.execute(sql`
          UPDATE processing_jobs
          SET status = 'completed',
              locked_at = NULL,
              locked_by = NULL,
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = ${nowIso}::timestamptz
          WHERE id = ${input.jobId}::uuid
            AND status = 'processing'
            AND locked_by = ${input.workerId}
          RETURNING id;
        `);

  if (result.rows.length === 0) {
    throw new LostLeaseError(table, input.jobId, input.workerId);
  }
}

export async function completeDiscoveryJob(input: CompleteJobInput): Promise<void> {
  return complete("discovery_jobs", input);
}

export async function completeProcessingJob(input: CompleteJobInput): Promise<void> {
  return complete("processing_jobs", input);
}

export interface FailJobOptions {
  maxAttempts?: number;
}

export interface FailJobInput {
  workerId: string;
  job: FailableJob;
  error: unknown;
  classification?: JobFailureClassification;
  now?: Date;
  options?: FailJobOptions;
}

async function fail(table: QueueTable, input: FailJobInput): Promise<void> {
  const db = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAttempts = input.options?.maxAttempts ?? input.job.maxAttempts;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const classification = classifyFailure(input.error, input.classification);
  const deadLetter = classification === "permanent" || input.job.attemptCount >= maxAttempts;

  if (deadLetter) {
    await db.transaction(async (tx) => {
      const updated =
        table === "discovery_jobs"
          ? await tx.execute(sql`
              UPDATE discovery_jobs
              SET status = 'dead_letter',
                  locked_at = NULL,
                  locked_by = NULL,
                  next_attempt_at = NULL,
                  last_error = ${message},
                  updated_at = ${nowIso}::timestamptz
              WHERE id = ${input.job.id}::uuid
                AND status = 'processing'
                AND locked_by = ${input.workerId}
              RETURNING id, campaign_id, payload, attempt_count;
            `)
          : await tx.execute(sql`
              UPDATE processing_jobs
              SET status = 'dead_letter',
                  locked_at = NULL,
                  locked_by = NULL,
                  next_attempt_at = NULL,
                  last_error = ${message},
                  updated_at = ${nowIso}::timestamptz
              WHERE id = ${input.job.id}::uuid
                AND status = 'processing'
                AND locked_by = ${input.workerId}
              RETURNING id, campaign_id, payload, attempt_count;
            `);

      const row = updated.rows[0] as
        | {
            id: string;
            campaign_id: string;
            payload: Record<string, unknown>;
            attempt_count: number;
          }
        | undefined;

      if (!row) {
        throw new LostLeaseError(table, input.job.id, input.workerId);
      }

      await tx
        .insert(deadLetterJobs)
        .values({
          sourceTable: table,
          sourceJobId: row.id,
          campaignId: row.campaign_id,
          payload: row.payload,
          attemptCount: row.attempt_count,
          lastError: message,
        })
        .onConflictDoNothing({
          target: [deadLetterJobs.sourceTable, deadLetterJobs.sourceJobId],
        });
    });
    return;
  }

  const backoffMs = computeBackoffMs(input.job.attemptCount);
  const nextAttemptAtIso = new Date(now.getTime() + backoffMs).toISOString();

  const result =
    table === "discovery_jobs"
      ? await db.execute(sql`
          UPDATE discovery_jobs
          SET status = 'pending',
              locked_at = NULL,
              locked_by = NULL,
              next_attempt_at = ${nextAttemptAtIso}::timestamptz,
              last_error = ${message},
              updated_at = ${nowIso}::timestamptz
          WHERE id = ${input.job.id}::uuid
            AND status = 'processing'
            AND locked_by = ${input.workerId}
          RETURNING id;
        `)
      : await db.execute(sql`
          UPDATE processing_jobs
          SET status = 'pending',
              locked_at = NULL,
              locked_by = NULL,
              next_attempt_at = ${nextAttemptAtIso}::timestamptz,
              last_error = ${message},
              updated_at = ${nowIso}::timestamptz
          WHERE id = ${input.job.id}::uuid
            AND status = 'processing'
            AND locked_by = ${input.workerId}
          RETURNING id;
        `);

  if (result.rows.length === 0) {
    throw new LostLeaseError(table, input.job.id, input.workerId);
  }
}

export async function failDiscoveryJob(input: FailJobInput): Promise<void> {
  return fail("discovery_jobs", input);
}

export async function failProcessingJob(input: FailJobInput): Promise<void> {
  return fail("processing_jobs", input);
}

export interface EnqueueJobInput {
  campaignId: string;
  type: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  idempotencyKey?: string | null;
}

async function enqueueDiscovery(input: EnqueueJobInput): Promise<string> {
  const db = getDb();
  const values = {
    campaignId: input.campaignId,
    type: input.type,
    payload: input.payload,
    maxAttempts: input.maxAttempts ?? 5,
    idempotencyKey: input.idempotencyKey ?? null,
  };

  if (!input.idempotencyKey) {
    const [row] = await db.insert(discoveryJobs).values(values).returning({ id: discoveryJobs.id });
    if (!row) throw new Error("Failed to enqueue discovery job.");
    return row.id;
  }

  const [inserted] = await db.insert(discoveryJobs).values(values).onConflictDoNothing().returning({ id: discoveryJobs.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: discoveryJobs.id })
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.idempotencyKey, input.idempotencyKey), inArray(discoveryJobs.status, ["pending", "processing"])))
    .limit(1);

  if (!existing) throw new Error(`Failed to resolve idempotent discovery enqueue for key ${input.idempotencyKey}.`);
  return existing.id;
}

async function enqueueProcessing(input: EnqueueJobInput): Promise<string> {
  const db = getDb();
  const values = {
    campaignId: input.campaignId,
    type: input.type,
    payload: input.payload,
    maxAttempts: input.maxAttempts ?? 5,
    idempotencyKey: input.idempotencyKey ?? null,
  };

  if (!input.idempotencyKey) {
    const [row] = await db.insert(processingJobs).values(values).returning({ id: processingJobs.id });
    if (!row) throw new Error("Failed to enqueue processing job.");
    return row.id;
  }

  const [inserted] = await db.insert(processingJobs).values(values).onConflictDoNothing().returning({ id: processingJobs.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(and(eq(processingJobs.idempotencyKey, input.idempotencyKey), inArray(processingJobs.status, ["pending", "processing"])))
    .limit(1);

  if (!existing) throw new Error(`Failed to resolve idempotent processing enqueue for key ${input.idempotencyKey}.`);
  return existing.id;
}

export async function enqueueDiscoveryJob(input: EnqueueJobInput): Promise<string> {
  return enqueueDiscovery(input);
}

export async function enqueueProcessingJob(input: EnqueueJobInput): Promise<string> {
  return enqueueProcessing(input);
}
