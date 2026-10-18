import { sql } from "drizzle-orm";
import { PROVIDER_DEFERRED_JOB_ERROR_PREFIX } from "@/domain/discovery/types";
import type { WatchdogQueueSignals } from "@/services/autopilot/watchdog-pause-policy";
import { getDb } from "../db";
import { JOB_LEASE_MS, STALE_JOB_LOCK_THRESHOLD_MS } from "./job-queue";

export interface WatchdogWorkspaceSignals extends WatchdogQueueSignals {
  workspaceId: string;
  systemPaused: boolean;
  systemPauseReason: string | null;
  systemPausedAt: Date | null;
  oldestDueDiscoveryAgeMinutes: number | null;
  oldestProcessingAgeMinutes: number | null;
  recoveryProbeDiscoveryCount: number;
}

export interface RecoveryProbeDiscoveryJobDiagnostic {
  id: string;
  campaignId: string;
  engineType: string | null;
  origin: "recovery_probe";
  desiredRawCount: number | null;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date | string;
  nextAttemptAt: Date | string | null;
  lockedAt: Date | string | null;
  lockExpiresAt: Date | string | null;
  providerDeferred: boolean;
  lastErrorPresent: boolean;
}

export function buildRecoveryProbeDiscoveryJobsQuery(workspaceId: string) {
  return sql`
    SELECT dj.id,
      dj.campaign_id,
      dj.payload->>'engineType' AS engine_type,
      dj.payload->>'origin' AS origin,
      NULLIF(dj.payload->>'desiredRawCount', '')::int AS desired_raw_count,
      dj.status,
      dj.attempt_count,
      dj.max_attempts,
      dj.created_at,
      dj.next_attempt_at,
      dj.locked_at,
      CASE WHEN dj.locked_at IS NULL THEN NULL
        ELSE dj.locked_at + (${JOB_LEASE_MS} * INTERVAL '1 millisecond')
      END AS lock_expires_at,
      LEFT(COALESCE(dj.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) = ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX} AS provider_deferred,
      dj.last_error IS NOT NULL AS last_error_present
    FROM discovery_jobs dj
    INNER JOIN campaigns c ON c.id = dj.campaign_id
    WHERE c.workspace_id = ${workspaceId}::uuid
      AND dj.payload->>'origin' = 'recovery_probe'
    ORDER BY dj.created_at DESC, dj.id DESC
    LIMIT 10;
  `;
}

function toNullableCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function toDiagnosticTimestamp(value: unknown): Date | string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  return typeof value === "string" ? value : null;
}

export async function getRecoveryProbeDiscoveryJobs(workspaceId: string): Promise<RecoveryProbeDiscoveryJobDiagnostic[]> {
  const result = await getDb().execute(buildRecoveryProbeDiscoveryJobsQuery(workspaceId));
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    campaignId: String(row.campaign_id),
    engineType: typeof row.engine_type === "string" ? row.engine_type : null,
    origin: "recovery_probe",
    desiredRawCount: toNullableCount(row.desired_raw_count),
    status: String(row.status),
    attemptCount: toNullableCount(row.attempt_count) ?? 0,
    maxAttempts: toNullableCount(row.max_attempts) ?? 0,
    createdAt: toDiagnosticTimestamp(row.created_at) ?? "",
    nextAttemptAt: toDiagnosticTimestamp(row.next_attempt_at),
    lockedAt: toDiagnosticTimestamp(row.locked_at),
    lockExpiresAt: toDiagnosticTimestamp(row.lock_expires_at),
    providerDeferred: row.provider_deferred === true,
    lastErrorPresent: row.last_error_present === true,
  }));
}

export function buildWatchdogWorkspaceSignalsQuery(workspaceId?: string) {
  const workspaceFilter = workspaceId ? sql`WHERE id = ${workspaceId}::uuid` : sql``;
  const oldDueDiscovery = sql`
    dj.status = 'pending'
    AND (dj.next_attempt_at IS NULL OR dj.next_attempt_at <= NOW())
    AND LEFT(COALESCE(dj.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) <> ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX}
    AND COALESCE(dj.payload->>'origin', '') <> 'recovery_probe'
    AND dj.created_at < NOW() - INTERVAL '30 minutes'
  `;
  const providerDeferredDiscovery = sql`
    dj.status = 'pending'
    AND (
      dj.next_attempt_at > NOW()
      OR LEFT(COALESCE(dj.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) = ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX}
    )
  `;
  const recoveryProbeDiscovery = sql`
    dj.status IN ('pending', 'processing')
    AND dj.payload->>'origin' = 'recovery_probe'
  `;
  const oldProcessing = sql`
    pj.status = 'pending'
    AND (pj.next_attempt_at IS NULL OR pj.next_attempt_at <= NOW())
    AND pj.created_at < NOW() - INTERVAL '30 minutes'
  `;
  const staleLockMinutes = STALE_JOB_LOCK_THRESHOLD_MS / 60_000;
  const staleDiscoveryLock = sql`
    dj.status = 'processing'
    AND dj.locked_at < NOW() - (${staleLockMinutes} * INTERVAL '1 minute')
  `;
  const staleProcessingLock = sql`
    pj.status = 'processing'
    AND pj.locked_at < NOW() - (${staleLockMinutes} * INTERVAL '1 minute')
  `;

  return sql`
    WITH scoped_workspaces AS (
      SELECT id FROM workspaces ${workspaceFilter}
    ),
    discovery_health AS (
      SELECT c.workspace_id,
        COUNT(*) FILTER (WHERE ${oldDueDiscovery})::int AS old_due_discovery,
        MIN(dj.created_at) FILTER (WHERE ${oldDueDiscovery}) AS oldest_due_discovery_at,
        COUNT(*) FILTER (WHERE ${providerDeferredDiscovery})::int AS deferred_discovery,
        COUNT(*) FILTER (WHERE ${recoveryProbeDiscovery})::int AS recovery_probe_discovery,
        COUNT(*) FILTER (WHERE ${staleDiscoveryLock})::int AS stale_discovery_locks
      FROM discovery_jobs dj
      JOIN campaigns c ON c.id = dj.campaign_id
      JOIN scoped_workspaces w ON w.id = c.workspace_id
      GROUP BY c.workspace_id
    ),
    processing_health AS (
      SELECT c.workspace_id,
        COUNT(*) FILTER (WHERE ${oldProcessing})::int AS old_processing,
        MIN(pj.created_at) FILTER (WHERE ${oldProcessing}) AS oldest_processing_at,
        COUNT(*) FILTER (WHERE ${staleProcessingLock})::int AS stale_processing_locks
      FROM processing_jobs pj
      JOIN campaigns c ON c.id = pj.campaign_id
      JOIN scoped_workspaces w ON w.id = c.workspace_id
      GROUP BY c.workspace_id
    ),
    workspace_health AS (
      SELECT w.id AS workspace_id,
        COALESCE(dh.old_due_discovery, 0)::int AS old_due_discovery,
        dh.oldest_due_discovery_at,
        COALESCE(dh.deferred_discovery, 0)::int AS deferred_discovery,
        COALESCE(dh.recovery_probe_discovery, 0)::int AS recovery_probe_discovery,
        COALESCE(dh.stale_discovery_locks, 0)::int AS stale_discovery_locks,
        COALESCE(ph.old_processing, 0)::int AS old_processing,
        ph.oldest_processing_at,
        COALESCE(ph.stale_processing_locks, 0)::int AS stale_processing_locks,
        (SELECT COUNT(*) FROM provider_runs pr
          WHERE pr.workspace_id = w.id AND pr.status = 'manual_reconciliation_required')::int AS provider_reconciliations
      FROM scoped_workspaces w
      LEFT JOIN discovery_health dh ON dh.workspace_id = w.id
      LEFT JOIN processing_health ph ON ph.workspace_id = w.id
    )
    SELECT wh.*,
      CASE WHEN wh.oldest_due_discovery_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (NOW() - wh.oldest_due_discovery_at)) / 60.0
      END::float AS oldest_due_discovery_age_minutes,
      CASE WHEN wh.oldest_processing_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (NOW() - wh.oldest_processing_at)) / 60.0
      END::float AS oldest_processing_age_minutes,
      aps.system_paused,
      aps.system_pause_reason,
      aps.system_paused_at
    FROM workspace_health wh
    JOIN autopilot_settings aps ON aps.workspace_id = wh.workspace_id AND aps.enabled = true
  `;
}

function toCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function toAgeMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const age = Number(value);
  return Number.isFinite(age) ? age : null;
}

export async function getWatchdogWorkspaceSignals(workspaceId?: string): Promise<WatchdogWorkspaceSignals[]> {
  const result = await getDb().execute(buildWatchdogWorkspaceSignalsQuery(workspaceId));
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    workspaceId: String(row.workspace_id),
    oldDueDiscovery: toCount(row.old_due_discovery),
    deferredDiscovery: toCount(row.deferred_discovery),
    oldProcessing: toCount(row.old_processing),
    staleDiscoveryLocks: toCount(row.stale_discovery_locks),
    staleProcessingLocks: toCount(row.stale_processing_locks),
    manualReconciliations: toCount(row.provider_reconciliations),
    systemPaused: row.system_paused === true,
    systemPauseReason: typeof row.system_pause_reason === "string" ? row.system_pause_reason : null,
    systemPausedAt: row.system_paused_at ? new Date(String(row.system_paused_at)) : null,
    oldestDueDiscoveryAgeMinutes: toAgeMinutes(row.oldest_due_discovery_age_minutes),
    oldestProcessingAgeMinutes: toAgeMinutes(row.oldest_processing_age_minutes),
    recoveryProbeDiscoveryCount: toCount(row.recovery_probe_discovery),
  }));
}