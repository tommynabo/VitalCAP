import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDayBounds } from "@/lib/time/day-bounds";
import { getDb } from "../db";
import { buildDailyRawRequestCommitmentCtes, executeUnderGlobalDailyRawCapLock } from "./daily-raw-request-cap";
import { discoveryJobs, rawCandidates } from "../schema/discovery";
import { providerRuns } from "../schema/providers";
import type { ProviderUsageStats } from "@/domain/providers/types";
import { ProviderBudgetExceededError, ProviderFailureError, ProviderSafetyError } from "@/domain/providers/errors";
import { createApifyConfigurationFingerprint, createApifyCredentialFingerprint, evaluateApifyRecovery, hasCurrentCredentialRecoveryProbeInFlight, resolveApifyRecoveryCredentialFingerprint, type ApifyRecoveryRun } from "@/services/discovery/provider-health";
import { getCoreEnv, getMapsEnv, getSerperEnv } from "@/lib/config/env";
import { SERPER_ESTIMATED_COST_PER_QUERY_USD } from "@/infrastructure/providers/serp/serper-provider";
import type { EconomicPacingState } from "@/services/autopilot/economic-pacing";

export interface RecordProviderRunInput {
  workspaceId: string;
  campaignId?: string | null;
  provider: string;
  operation: string;
  externalRunId?: string | null;
  externalDatasetId?: string | null;
  status: ProviderRunStatus;
  requestKey?: string | null;
  actorId?: string | null;
  seedId?: string | null;
  ingestedAt?: Date | null;
  error?: string | null;
  itemsRequested?: number;
  itemsReturned: number;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

export type ProviderRunStatus = "starting" | "queued" | "running" | "succeeded" | "ingesting" | "failed" | "aborted" | "timed_out" | "ingested" | "completed" | "budget_blocked" | "manual_reconciliation_required";

export interface ReserveSerperProviderRunInput {
  workspaceId: string;
  campaignId: string;
  requestKey: string;
  seedId?: string | null;
  itemsRequested: number;
  costUsd: number;
  dailyCostLimitUsd: number;
  metadata: Record<string, unknown>;
  timeZone?: string;
}

export interface SerperRecoveryState {
  allocationPaused: boolean;
  recoveryProbeEligible: boolean;
  nextRecoveryAttemptAt: Date | null;
  lastFailureAt: Date | null;
  recoveredAt: Date | null;
}

export interface SerperRecoveryEvent {
  status: string;
  purpose: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  credentialFingerprint: string | null;
}

export function resolveSerperRecoveryState(input: {
  latest: SerperRecoveryEvent | undefined;
  currentCredentialFingerprint: string | null;
  now: Date;
}): SerperRecoveryState {
  const { latest, currentCredentialFingerprint, now } = input;
  if (!latest || (latest.purpose === "recovery_probe" && latest.status === "completed")) {
    return {
      allocationPaused: false,
      recoveryProbeEligible: false,
      nextRecoveryAttemptAt: null,
      lastFailureAt: null,
      recoveredAt: latest?.finishedAt ?? latest?.startedAt ?? null,
    };
  }

  const lastFailureAt = latest.finishedAt ?? latest.startedAt;
  const credentialChanged = currentCredentialFingerprint !== null
    && (latest.credentialFingerprint === null || latest.credentialFingerprint !== currentCredentialFingerprint);
  const nextRecoveryAttemptAt = credentialChanged
    ? now
    : new Date(lastFailureAt.getTime() + 60 * 60 * 1000);
  return {
    allocationPaused: true,
    recoveryProbeEligible: now >= nextRecoveryAttemptAt,
    nextRecoveryAttemptAt,
    lastFailureAt,
    recoveredAt: null,
  };
}

export interface SerperPurposeUsageDiagnostics {
  queriesToday: number;
  successfulQueriesToday: number;
  estimatedBillableAttemptsToday: number;
  spendTodayUsd: number;
  providerResultsToday: number;
  queriesRolling30Days: number;
  successfulQueriesRolling30Days: number;
  rolling30DaySpendUsd: number;
}

export interface SerperCostDiagnostics {
  dailyCapUsd: number;
  spendTodayUsd: number;
  budgetRemainingUsd: number;
  projected15DayMaxSpendUsd: number;
  projected30DayMaxSpendUsd: number;
  rolling30DaySpendUsd: number;
  rollingAverageDailySpendUsd: number;
  projectedBalanceLifetimeDays: number | null;
  operatorProvidedBalanceUsd: number | null;
  estimatedBillableAttemptsToday: number;
  estimatedMaxDailyAttempts: number;
  purposes: Record<string, SerperPurposeUsageDiagnostics>;
  mapsFastRecovery: {
    attempts: number;
    succeeded: number;
    recoveredWithEmail: number;
    recoveredValidEmails: number | null;
    recoveredImports: number | null;
    costPerRecoveredWebsiteUsd: number | null;
    costPerValidEmailUsd: number | null;
    costPerConfirmedImportUsd: number | null;
  };
}

export function buildLatestProviderEconomicPacingStatesQuery(workspaceId: string, timeZone: string, now: Date) {
  const { start, end } = getDayBounds(timeZone, now);
  return sql`
    SELECT DISTINCT ON (provider)
      provider,
      metadata->>'economicPaceState' AS economic_pace_state
    FROM provider_runs
    WHERE workspace_id = ${workspaceId}::uuid
      AND provider IN ('apify', 'serper')
      AND metadata->>'economicPaceState' IN ('UNDER_PACE', 'ON_PACE', 'AHEAD_OF_BUDGET_PACE', 'NEAR_DAILY_CAP')
      AND started_at >= ${start.toISOString()}::timestamptz
      AND started_at < ${end.toISOString()}::timestamptz
    ORDER BY provider, started_at DESC
  `;
}

export async function getLatestProviderEconomicPacingStates(
  workspaceId: string,
  timeZone: string,
  now: Date,
): Promise<Partial<Record<"apify" | "serper", EconomicPacingState>>> {
  const result = await getDb().execute(buildLatestProviderEconomicPacingStatesQuery(workspaceId, timeZone, now));
  const states: Partial<Record<"apify" | "serper", EconomicPacingState>> = {};
  for (const row of result.rows as Array<{ provider?: unknown; economic_pace_state?: unknown }>) {
    const provider = row.provider;
    const state = row.economic_pace_state;
    if ((provider === "apify" || provider === "serper")
      && typeof state === "string"
      && ["UNDER_PACE", "ON_PACE", "AHEAD_OF_BUDGET_PACE", "NEAR_DAILY_CAP"].includes(state)) {
      states[provider] = state as EconomicPacingState;
    }
  }
  return states;
}

export async function reserveSerperProviderRun(input: ReserveSerperProviderRunInput): Promise<{ providerRun: typeof providerRuns.$inferSelect; created: boolean }> {
  const db = getDb();
  const maxRequests = getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS;
  const now = new Date();
  const [row] = await executeUnderGlobalDailyRawCapLock(buildReserveSerperProviderRunQuery(input, maxRequests, now)) as Array<{
    inserted_row: unknown;
    safety_row: { committed_raw_requests: number; additional_raw_requests: number } | null;
    serper_spent_today: number;
    existing_row: unknown;
  }>;
  if (row?.inserted_row || row?.existing_row) {
    const existing = await getProviderRunByRequestKey(input.requestKey);
    if (!existing) throw new Error(`Unable to resolve Serper provider run ${input.requestKey}.`);
    return { providerRun: existing, created: Boolean(row.inserted_row) };
  }

  if (row?.safety_row && row.safety_row.committed_raw_requests + row.safety_row.additional_raw_requests > maxRequests) {
    const retryAt = getDayBounds(input.timeZone ?? "Europe/Madrid", now).end;
    throw new ProviderBudgetExceededError("Provider reservation is blocked by the daily raw request cap.", retryAt, "raw_request_cap");
  }
  if (row && Number(row.serper_spent_today) + input.costUsd > input.dailyCostLimitUsd) {
    const retryAt = getDayBounds(input.timeZone ?? "Europe/Madrid", now).end;
    throw new ProviderBudgetExceededError("Serper reservation is blocked by the daily cost limit.", retryAt);
  }
  throw new Error(`Unable to reserve Serper provider run ${input.requestKey}.`);
}

export function buildReserveSerperProviderRunQuery(input: ReserveSerperProviderRunInput, maxRequests: number, now: Date) {
  const discoveryJobId = typeof input.metadata.discoveryJobId === "string" ? input.metadata.discoveryJobId : "";
  const { start, end } = getDayBounds("UTC", now);
  return sql`
    WITH ${buildDailyRawRequestCommitmentCtes(now)},
    raw_safety AS (
      SELECT daily_raw_commitment.committed_raw_requests,
        COALESCE((
          SELECT GREATEST(
            CASE WHEN job.payload->>'desiredRawCount' ~ '^[0-9]+$'
              THEN (job.payload->>'desiredRawCount')::int ELSE 0 END
              - COALESCE((SELECT run.provider_reserved_raw_requests FROM provider_requests_by_discovery_job run
                WHERE run.discovery_job_id = job.id::text), 0),
            0
          )
          FROM discovery_jobs job
          WHERE job.id::text = ${discoveryJobId}
            AND job.status IN ('pending', 'processing')
        ), 0)::int AS job_unrepresented_raw_requests
      FROM daily_raw_commitment
    ),
    safety AS (
      SELECT committed_raw_requests,
        GREATEST(${input.itemsRequested} - job_unrepresented_raw_requests, 0)::int AS additional_raw_requests
      FROM raw_safety
    ),
    cost_safety AS (
      SELECT COALESCE(SUM(cost_usd), 0)::numeric AS spent_today
      FROM provider_runs
      WHERE provider = 'serper'
        AND started_at >= ${start}
        AND started_at < ${end}
    ),
    inserted AS (
      INSERT INTO provider_runs (
        workspace_id, campaign_id, provider, operation, request_key, seed_id, status,
        items_requested, items_returned, cost_usd, metadata
      )
      SELECT ${input.workspaceId}::uuid, ${input.campaignId}::uuid, 'serper', 'search',
        ${input.requestKey}, ${input.seedId ?? null}::uuid, 'starting', ${input.itemsRequested},
        0, ${input.costUsd}, ${JSON.stringify(input.metadata)}::jsonb
      FROM safety, cost_safety
      WHERE safety.committed_raw_requests + safety.additional_raw_requests <= ${maxRequests}
        AND cost_safety.spent_today + ${input.costUsd} <= ${input.dailyCostLimitUsd}
      ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING
      RETURNING *
    )
    SELECT
      (SELECT row_to_json(inserted.*) FROM inserted) AS inserted_row,
      (SELECT row_to_json(safety.*) FROM safety) AS safety_row,
      (SELECT spent_today FROM cost_safety) AS serper_spent_today,
      (SELECT row_to_json(existing.*) FROM provider_runs existing WHERE existing.request_key = ${input.requestKey}) AS existing_row
  `;
}

/**
 * Persists one provider-run event (Prompt 7 §14 cost-guard audit trail —
 * actor ID, run ID, dataset ID, status, item count, cost). Used by the real
 * Apify/Serper/MillionVerifier adapters at the composition root; the
 * adapters themselves stay DB-free and only call an injected callback that
 * wraps this function.
 */
export async function recordProviderRun(input: RecordProviderRunInput): Promise<void> {
  const db = getDb();
  await db.insert(providerRuns).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId ?? null,
    provider: input.provider,
    operation: input.operation,
    requestKey: input.requestKey ?? null,
    actorId: input.actorId ?? null,
    seedId: input.seedId ?? null,
    externalRunId: input.externalRunId ?? null,
    externalDatasetId: input.externalDatasetId ?? null,
    status: input.status,
    itemsRequested: input.itemsRequested ?? 0,
    itemsReturned: input.itemsReturned,
    costUsd: input.costUsd,
    metadata: input.metadata ?? {},
    ingestedAt: input.ingestedAt ?? null,
    error: input.error ?? null,
    startedAt: new Date(),
    finishedAt: input.status === "queued" || input.status === "running" ? null : new Date(),
  });
}

export interface CreateProviderRunInput {
  workspaceId: string;
  campaignId: string;
  provider: string;
  operation: string;
  requestKey: string;
  actorId: string;
  seedId: string;
  externalRunId: string;
  externalDatasetId: string | null;
  status: "queued" | "running";
  itemsRequested: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface ReserveApifyProviderRunInput {
  workspaceId: string;
  campaignId: string;
  operation: string;
  requestKey: string;
  actorId?: string | null;
  seedId: string;
  itemsRequested: number;
  metadata?: Record<string, unknown>;
  recoveryProbe?: boolean;
}

export type ApifyReservationFailureKind =
  | "SETTINGS_MISSING"
  | "MANUAL_RECONCILIATION"
  | "RAW_CAP"
  | "DAILY_COST_CAP"
  | "CONCURRENCY_LIMIT"
  | "RECOVERY_ALREADY_IN_FLIGHT"
  | "DUPLICATE_REQUEST"
  | "SQL_OR_UNKNOWN_RESERVATION_FAILURE";

const SAFE_RESERVATION_FAILURE_MESSAGES: Record<ApifyReservationFailureKind, string> = {
  SETTINGS_MISSING: "Apify reservation settings are unavailable.",
  MANUAL_RECONCILIATION: "Provider reservation is blocked by unresolved manual reconciliation.",
  RAW_CAP: "Provider reservation is blocked by the daily raw request cap.",
  DAILY_COST_CAP: "Provider reservation is blocked by the daily Apify spend cap.",
  CONCURRENCY_LIMIT: "Apify reservation is deferred by the workspace concurrency limit.",
  RECOVERY_ALREADY_IN_FLIGHT: "An Apify recovery probe is already in progress.",
  DUPLICATE_REQUEST: "An idempotent provider-run reservation already exists.",
  SQL_OR_UNKNOWN_RESERVATION_FAILURE: "Provider-run reservation failed before its outcome could be resolved.",
};

type TaggedApifyReservationError = Error & {
  reservationFailureKind: ApifyReservationFailureKind;
  reservationErrorClass?: string;
  reservationErrorCode?: string;
  retryAt?: Date | null;
};

export const MAX_CONCURRENT_APIFY_RUNS_PER_WORKSPACE = 4;

export function getSafePostgresErrorCode(error: unknown): string | undefined {
  const seen = new Set<Error>();
  let current: unknown = error;

  for (let depth = 0; depth < 3; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return undefined;
    seen.add(current);

    let code: unknown;
    let cause: unknown;
    try {
      code = (current as Error & { code?: unknown }).code;
      cause = current.cause;
    } catch {
      return undefined;
    }
    if (typeof code === "string" && code.length === 5 && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = cause;
  }

  return undefined;
}

function tagApifyReservationFailure<T extends Error>(
  error: T,
  failureKind: ApifyReservationFailureKind,
  reservationErrorClass?: string,
  reservationErrorCode?: string,
): T & TaggedApifyReservationError {
  return Object.assign(error, {
    reservationFailureKind: failureKind,
    ...(reservationErrorClass ? { reservationErrorClass } : {}),
    ...(reservationErrorCode ? { reservationErrorCode } : {}),
  });
}

export function getApifyReservationFailureDetails(error: unknown): {
  errorClass: string;
  safeErrorMessage: string;
  failureKind: ApifyReservationFailureKind;
  retryAt?: Date;
} | null {
  if (!(error instanceof Error)) return null;
  const taggedError = error as Partial<TaggedApifyReservationError>;
  const failureKind = taggedError.reservationFailureKind;
  if (!failureKind || !Object.hasOwn(SAFE_RESERVATION_FAILURE_MESSAGES, failureKind)) return null;
  const errorCode = typeof taggedError.reservationErrorCode === "string" && /^[0-9A-Z]{5}$/.test(taggedError.reservationErrorCode)
    ? taggedError.reservationErrorCode
    : undefined;
  const retryAt = taggedError.retryAt instanceof Date ? taggedError.retryAt : undefined;
  return {
    errorClass: taggedError.reservationErrorClass ?? error.constructor.name,
    safeErrorMessage: `${SAFE_RESERVATION_FAILURE_MESSAGES[failureKind]}${errorCode ? ` SQLSTATE ${errorCode}.` : ""}`,
    failureKind,
    ...(retryAt ? { retryAt } : {}),
  };
}

export function buildReserveApifyProviderRunQuery(
  input: ReserveApifyProviderRunInput,
  maxRequests: number,
  maxCost: number,
  dayStart: Date,
  expectedCostUsd: number,
  now = new Date(),
  maxConcurrentRuns = MAX_CONCURRENT_APIFY_RUNS_PER_WORKSPACE,
) {
  const configurationFingerprint = typeof input.metadata?.configurationFingerprint === "string"
    ? input.metadata.configurationFingerprint
    : null;
  const credentialFingerprint = typeof input.metadata?.credentialFingerprint === "string"
    ? input.metadata.credentialFingerprint
    : null;
  return sql`
    WITH ${buildDailyRawRequestCommitmentCtes(now)},
    raw_safety AS (
      SELECT daily_raw_commitment.committed_raw_requests,
        COALESCE((
          SELECT GREATEST(
            CASE WHEN job.payload->>'desiredRawCount' ~ '^[0-9]+$'
              THEN (job.payload->>'desiredRawCount')::int ELSE 0 END
              - COALESCE((SELECT run.provider_reserved_raw_requests FROM provider_requests_by_discovery_job run
                WHERE run.discovery_job_id = job.id::text), 0),
            0
          )
          FROM discovery_jobs job
          WHERE job.id::text = ${typeof input.metadata?.discoveryJobId === "string" ? input.metadata.discoveryJobId : ""}
            AND job.status IN ('pending', 'processing')
        ), 0)::int AS job_unrepresented_raw_requests,
        (SELECT COUNT(*) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND status = 'manual_reconciliation_required')::int AS unreconciled_count,
        (SELECT COUNT(*) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND provider = 'apify' AND status IN ('starting', 'queued', 'running'))::int AS concurrent_apify_run_count,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND provider = 'apify' AND started_at >= ${dayStart.toISOString()}::timestamptz)::numeric AS cost_today,
        (SELECT COUNT(*) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND provider = 'apify' AND status IN ('starting', 'queued', 'running', 'succeeded', 'ingesting') AND COALESCE((metadata->>'recoveryProbe')::boolean, false) = true AND metadata->>'credentialFingerprint' = ${credentialFingerprint}::text)::int AS recovery_probe_count
      FROM daily_raw_commitment
    ),
    safety AS (
      SELECT
        raw_safety.unreconciled_count,
        raw_safety.concurrent_apify_run_count,
        raw_safety.committed_raw_requests AS requested_today,
        GREATEST(${input.itemsRequested} - raw_safety.job_unrepresented_raw_requests, 0)::int AS additional_raw_requests,
        raw_safety.cost_today,
        raw_safety.recovery_probe_count
      FROM raw_safety
    ),
    inserted AS (
      INSERT INTO provider_runs (
        workspace_id, campaign_id, provider, operation, request_key, actor_id, seed_id, status, items_requested, items_returned, cost_usd, metadata, started_at
      )
      SELECT
        ${input.workspaceId}::uuid, ${input.campaignId}::uuid, 'apify', ${input.operation}, ${input.requestKey},
        ${input.actorId ?? null}, ${input.seedId}::uuid, 'starting', ${input.itemsRequested}, 0, ${expectedCostUsd},
        ${JSON.stringify({ ...(input.metadata ?? {}), recoveryProbe: input.recoveryProbe ?? false })}::jsonb, NOW()
      FROM safety
      WHERE safety.unreconciled_count = 0
        AND safety.concurrent_apify_run_count < ${maxConcurrentRuns}
        AND safety.requested_today + safety.additional_raw_requests <= ${maxRequests}
        AND safety.cost_today + ${expectedCostUsd} <= ${maxCost}
        AND (${input.recoveryProbe ?? false} = false OR safety.recovery_probe_count = 0)
      ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING
      RETURNING *
    ),
    legacy_configuration_failure_marked AS (
      UPDATE provider_runs AS failure
      SET metadata = COALESCE(failure.metadata, '{}'::jsonb) || jsonb_build_object('configurationFingerprint', ${configurationFingerprint}::text)
      WHERE failure.id = (
        SELECT candidate.id
        FROM provider_runs candidate
        WHERE candidate.workspace_id = ${input.workspaceId}::uuid
          AND candidate.provider = 'apify'
          AND candidate.status IN ('failed', 'aborted', 'timed_out')
          AND candidate.metadata->>'failureKind' = 'configuration'
          AND NULLIF(candidate.metadata->>'configurationFingerprint', '') IS NULL
        ORDER BY COALESCE(candidate.finished_at, candidate.started_at) DESC
        LIMIT 1
      )
        AND ${input.recoveryProbe ?? false} = true
        AND ${configurationFingerprint}::text IS NOT NULL
        AND EXISTS (SELECT 1 FROM inserted)
      RETURNING failure.id
    )
    SELECT
      (SELECT row_to_json(inserted.*) FROM inserted) AS inserted_row,
      (SELECT row_to_json(safety.*) FROM safety) AS safety_row,
      (SELECT row_to_json(existing.*) FROM provider_runs existing WHERE existing.request_key = ${input.requestKey}) AS existing_row
  `;
}

export async function getApifyRecoverySnapshot(workspaceId: string, now = new Date()) {
  const db = getDb();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const mapsEnv = getMapsEnv();
  const [rows, failureRows, successRows] = await Promise.all([
    db.select({
      status: providerRuns.status,
      startedAt: providerRuns.startedAt,
      finishedAt: providerRuns.finishedAt,
      itemsReturned: providerRuns.itemsReturned,
      costUsd: providerRuns.costUsd,
      error: providerRuns.error,
      metadata: providerRuns.metadata,
      recoveryJobPayload: discoveryJobs.payload,
    }).from(providerRuns).leftJoin(discoveryJobs, sql`${providerRuns.metadata}->>'discoveryJobId' = ${discoveryJobs.id}::text`).where(and(
      eq(providerRuns.workspaceId, workspaceId),
      eq(providerRuns.provider, "apify"),
      ne(providerRuns.operation, "economic_pacing_state"),
      gte(providerRuns.startedAt, since),
    )),
    db.select({
      status: providerRuns.status,
      startedAt: providerRuns.startedAt,
      finishedAt: providerRuns.finishedAt,
      error: providerRuns.error,
      metadata: providerRuns.metadata,
    }).from(providerRuns).where(and(
      eq(providerRuns.workspaceId, workspaceId),
      eq(providerRuns.provider, "apify"),
      ne(providerRuns.operation, "economic_pacing_state"),
      inArray(providerRuns.status, ["failed", "aborted", "timed_out"]),
    )).orderBy(desc(sql`COALESCE(${providerRuns.finishedAt}, ${providerRuns.startedAt})`)).limit(1),
    db.select({
      startedAt: providerRuns.startedAt,
      finishedAt: providerRuns.finishedAt,
      metadata: providerRuns.metadata,
      recoveryJobPayload: discoveryJobs.payload,
    }).from(providerRuns).leftJoin(discoveryJobs, sql`${providerRuns.metadata}->>'discoveryJobId' = ${discoveryJobs.id}::text`).where(and(
      eq(providerRuns.workspaceId, workspaceId),
      eq(providerRuns.provider, "apify"),
      ne(providerRuns.operation, "economic_pacing_state"),
      inArray(providerRuns.status, ["succeeded", "ingested", "completed"]),
    )).orderBy(desc(sql`COALESCE(${providerRuns.finishedAt}, ${providerRuns.startedAt})`)).limit(1),
  ]);
  const runs: ApifyRecoveryRun[] = rows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const failureKind = metadata.failureKind;
    const credentialFingerprint = resolveApifyRecoveryCredentialFingerprint(
      metadata,
      row.recoveryJobPayload as Record<string, unknown> | null,
    );
    return {
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      itemsReturned: row.itemsReturned,
      costUsd: row.costUsd,
      recoveryProbe: metadata.recoveryProbe === true,
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
      ...(typeof metadata.configurationFingerprint === "string" ? { configurationFingerprint: metadata.configurationFingerprint } : {}),
      ...(failureKind === "transient" || failureKind === "billing" || failureKind === "authentication" || failureKind === "configuration" || failureKind === "safety" || failureKind === "actor_resource_limit"
        ? { failureKind }
        : {}),
    };
  });
  const failureRow = failureRows[0];
  const failureMetadata = (failureRow?.metadata ?? {}) as Record<string, unknown>;
  const failureKind = failureMetadata.failureKind;
  const latestFailure: ApifyRecoveryRun | null = failureRow ? {
    status: failureRow.status,
    startedAt: failureRow.startedAt,
    finishedAt: failureRow.finishedAt,
    itemsReturned: 0,
    costUsd: 0,
    ...(typeof failureMetadata.credentialFingerprint === "string" ? { credentialFingerprint: failureMetadata.credentialFingerprint } : {}),
    ...(typeof failureMetadata.configurationFingerprint === "string" ? { configurationFingerprint: failureMetadata.configurationFingerprint } : {}),
    ...(failureKind === "transient" || failureKind === "billing" || failureKind === "authentication" || failureKind === "configuration" || failureKind === "safety" || failureKind === "actor_resource_limit"
      ? { failureKind }
      : {}),
  } : null;
  const currentCredentialFingerprint = createApifyCredentialFingerprint(mapsEnv.APIFY_API_TOKEN);
  const probeInFlight = hasCurrentCredentialRecoveryProbeInFlight(runs, currentCredentialFingerprint);
  const unreconciled = await db.select({ id: providerRuns.id }).from(providerRuns).where(and(
    eq(providerRuns.workspaceId, workspaceId),
    eq(providerRuns.status, "manual_reconciliation_required"),
  )).limit(1);
  const latestSuccess = successRows[0];
  const latestSuccessMetadata = (latestSuccess?.metadata ?? {}) as Record<string, unknown>;
  const latestSuccessCredentialFingerprint = latestSuccess
    ? resolveApifyRecoveryCredentialFingerprint(
      latestSuccessMetadata,
      latestSuccess.recoveryJobPayload as Record<string, unknown> | null,
    ) ?? null
    : null;
  const recoverySnapshot = evaluateApifyRecovery(
    runs,
    latestFailure,
    successRows[0]?.finishedAt ?? successRows[0]?.startedAt ?? null,
    probeInFlight,
    unreconciled.length > 0,
    now,
    currentCredentialFingerprint,
    createApifyConfigurationFingerprint(mapsEnv),
    latestSuccessCredentialFingerprint,
  );
  return {
    ...recoverySnapshot,
    safetyBlocked: unreconciled.length > 0,
    recoveryProbeInFlight: probeInFlight,
    latestFailureKind: latestFailure?.failureKind ?? null,
    latestFailureAt: latestFailure?.finishedAt ?? latestFailure?.startedAt ?? null,
    latestFailureMessage: failureRow?.error ?? null,
    latestSuccessAt: successRows[0]?.finishedAt ?? successRows[0]?.startedAt ?? null,
    credentialChangedSinceLatestFailure: latestFailure
      ? currentCredentialFingerprint !== null && latestFailure.credentialFingerprint !== undefined
        ? latestFailure.credentialFingerprint !== currentCredentialFingerprint
        : null
      : null,
  };
}

export async function reserveApifyProviderRun(input: ReserveApifyProviderRunInput): Promise<{ providerRun: typeof providerRuns.$inferSelect; created: boolean }> {
  const db = getDb();

  // 1. Get settings and limits
  const { autopilotSettings } = await import("../schema/autopilot");
  const [settings] = await db.select({
    timezone: autopilotSettings.timezone,
    maxDailySpend: autopilotSettings.maxDailyApifySpendUsd
  }).from(autopilotSettings).where(eq(autopilotSettings.workspaceId, input.workspaceId));
  if (!settings) {
    throw tagApifyReservationFailure(new Error("Apify reservation settings are unavailable."), "SETTINGS_MISSING");
  }

  const env = await import("@/lib/config/env");
  const maxRequests = env.getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS;
  const maxCost = Math.min(env.getMapsEnv().APIFY_DAILY_COST_LIMIT_USD, settings.maxDailySpend ?? Number.POSITIVE_INFINITY);

  const now = new Date();
  const { start } = getDayBounds(settings.timezone, now);
  const expectedCostUsd = input.itemsRequested * 0.005; // conservative

  // 2. Atomic insertion with guard conditions in one Neon HTTP statement.
  let result;
  try {
    result = { rows: await executeUnderGlobalDailyRawCapLock(buildReserveApifyProviderRunQuery(
      input,
      maxRequests,
      maxCost,
      start,
      expectedCostUsd,
      now,
      MAX_CONCURRENT_APIFY_RUNS_PER_WORKSPACE,
    )) };
  } catch (error) {
    const errorCode = getSafePostgresErrorCode(error);
    throw tagApifyReservationFailure(
      new Error(`Provider-run reservation query failed.${errorCode ? ` SQLSTATE ${errorCode}.` : ""}`),
      "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
      error instanceof Error ? error.constructor.name : typeof error,
      errorCode,
    );
  }

  const row = result.rows[0] as {
    inserted_row: unknown;
    safety_row: { unreconciled_count: number; concurrent_apify_run_count: number; requested_today: number; additional_raw_requests: number; cost_today: number; recovery_probe_count: number } | null;
    existing_row: unknown;
  } | undefined;
  if (row?.inserted_row) {
    let insertedRow;
    try {
      insertedRow = await getProviderRunByRequestKey(input.requestKey);
    } catch (error) {
      throw tagApifyReservationFailure(
        new Error("Created provider-run reservation could not be loaded."),
        "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
        error instanceof Error ? error.constructor.name : typeof error,
      );
    }
    if (!insertedRow) {
      throw tagApifyReservationFailure(
        new Error("Created provider-run reservation could not be loaded."),
        "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
      );
    }
    return { providerRun: insertedRow, created: true };
  }
  if (row?.existing_row) {
    let existing;
    try {
      existing = await getProviderRunByRequestKey(input.requestKey);
    } catch (error) {
      throw tagApifyReservationFailure(
        new Error("Existing provider-run reservation could not be loaded."),
        "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
        error instanceof Error ? error.constructor.name : typeof error,
      );
    }
    if (!existing) {
      throw tagApifyReservationFailure(
        new Error("Existing provider-run reservation could not be loaded."),
        "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
      );
    }
    return { providerRun: existing, created: false };
  }

  const safety = row?.safety_row;
  if (safety?.unreconciled_count) {
    throw tagApifyReservationFailure(
      new ProviderSafetyError("Provider reservation is blocked by unresolved manual reconciliation."),
      "MANUAL_RECONCILIATION",
    );
  }
  if (safety && safety.requested_today + safety.additional_raw_requests > maxRequests) {
    const { end: retryAt } = getDayBounds(settings.timezone);
    throw tagApifyReservationFailure(
      new ProviderBudgetExceededError("Provider reservation is blocked by the daily raw request cap.", retryAt, "raw_request_cap"),
      "RAW_CAP",
    );
  }
  if (safety && safety.cost_today + expectedCostUsd > maxCost) {
    const { end: retryAt } = getDayBounds(settings.timezone);
    throw tagApifyReservationFailure(
      new ProviderBudgetExceededError("Provider reservation is blocked by the daily Apify spend cap.", retryAt),
      "DAILY_COST_CAP",
    );
  }
  if (safety && safety.concurrent_apify_run_count >= MAX_CONCURRENT_APIFY_RUNS_PER_WORKSPACE) {
    const retryAt = new Date(now.getTime() + 60 * 1000);
    throw tagApifyReservationFailure(
      new ProviderFailureError("Apify workspace concurrency limit is reached; defer this reservation.", "transient", retryAt),
      "CONCURRENCY_LIMIT",
    );
  }
  if (input.recoveryProbe && safety?.recovery_probe_count) {
    throw tagApifyReservationFailure(
      new ProviderSafetyError("An Apify recovery probe is already in progress."),
      "RECOVERY_ALREADY_IN_FLIGHT",
    );
  }
  throw tagApifyReservationFailure(
    new Error("Provider-run reservation outcome could not be resolved."),
    "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
  );
}

export async function createProviderRun(input: CreateProviderRunInput): Promise<string> {
  const db = getDb();
  const [inserted] = await db
    .insert(providerRuns)
    .values({ ...input, costUsd: input.costUsd ?? 0, metadata: input.metadata ?? {}, itemsReturned: 0 })
    .onConflictDoNothing({ target: providerRuns.requestKey })
    .returning({ id: providerRuns.id });
  if (inserted) return inserted.id;
  const existing = await getProviderRunByRequestKey(input.requestKey);
  if (!existing) throw new Error(`Unable to resolve provider run request key ${input.requestKey}.`);
  return existing.id;
}

export async function getProviderRunByRequestKey(requestKey: string) {
  const db = getDb();
  const [row] = await db.select().from(providerRuns).where(eq(providerRuns.requestKey, requestKey)).limit(1);
  return row ?? null;
}

export function buildApifyPollingDuePredicate(now = new Date()) {
  return sql`(metadata->>'pollRetryAt' IS NULL OR (metadata->>'pollRetryAt')::timestamptz <= ${now.toISOString()}::timestamptz)`;
}

export async function listApifyRunsForPolling(limit: number, now = new Date()) {
  const db = getDb();
  return db
    .select()
    .from(providerRuns)
    .where(and(
      eq(providerRuns.provider, "apify"),
      inArray(providerRuns.status, ["starting", "queued", "running", "succeeded"]),
      buildApifyPollingDuePredicate(now),
    ))
    .orderBy(asc(providerRuns.startedAt), asc(providerRuns.id))
    .limit(limit);
}

export async function claimProviderRunForIngestion(id: string, token: string) {
  const db = getDb();
  const [claimed] = await db
    .update(providerRuns)
    .set({
      status: "ingesting",
      ingestionStartedAt: new Date(),
      ingestionAttemptCount: sql`${providerRuns.ingestionAttemptCount} + 1`,
      ingestionClaimToken: token,
    })
    .where(and(eq(providerRuns.id, id), eq(providerRuns.status, "succeeded")))
    .returning();
  return claimed ?? null;
}

export async function updateProviderRun(
  id: string,
  patch: Partial<{
    status: ProviderRunStatus;
    externalRunId: string | null;
    actorId: string | null;
    externalDatasetId: string | null;
    itemsRequested: number;
    itemsReturned: number;
    costUsd: number;
    finishedAt: Date | null;
    ingestedAt: Date | null;
    error: string | null;
    metadata: Record<string, unknown>;
    seedRunId: string | null;
    lastIngestionError: string | null;
  }>,
): Promise<void> {
  const db = getDb();
  await db.update(providerRuns).set(patch).where(eq(providerRuns.id, id));
}

export async function recoverFailedIngestion(id: string, token: string, workspaceId: string, errorString: string): Promise<void> {
  const db = getDb();
  const [current] = await db.select({ attempt: providerRuns.ingestionAttemptCount }).from(providerRuns).where(and(eq(providerRuns.id, id), eq(providerRuns.ingestionClaimToken, token)));
  if (!current) return;
  
  if (current.attempt < 5) {
    await db.update(providerRuns).set({
      status: "succeeded",
      ingestionClaimToken: null,
      ingestionStartedAt: null,
      lastIngestionError: errorString
    }).where(and(eq(providerRuns.id, id), eq(providerRuns.ingestionClaimToken, token)));
  } else {
    await db.update(providerRuns).set({
      status: "manual_reconciliation_required",
      lastIngestionError: errorString
    }).where(and(eq(providerRuns.id, id), eq(providerRuns.ingestionClaimToken, token)));
    
    // Autopilot settings update
    const { autopilotSettings } = await import("../schema/autopilot");
    await db.update(autopilotSettings).set({
      systemPaused: true,
      systemPauseReason: "provider_reconciliation",
      updatedAt: new Date()
    }).where(eq(autopilotSettings.workspaceId, workspaceId));
  }
}

/**
 * Sum of `cost_usd` for a provider within the current UTC calendar day.
 * Semantics of `cost_usd`: 
 * - Represents the reserved expected cost until the run is terminal.
 * - Represents the actual final cost afterward.
 * This budget query accounts conservatively without double-counting.
 */
export async function getTodaySpendUsd(workspaceId: string, provider: string, timeZone = "Europe/Madrid", now = new Date(), excludeRequestKey?: string): Promise<number> {
  const db = getDb();
  const { start, end } = getDayBounds(timeZone, now);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${providerRuns.costUsd}), 0)` })
    .from(providerRuns)
    .where(and(
      eq(providerRuns.workspaceId, workspaceId),
      eq(providerRuns.provider, provider),
      gte(providerRuns.startedAt, start),
      sql`${providerRuns.startedAt} < ${end}`,
      ...(excludeRequestKey ? [sql`${providerRuns.requestKey} IS DISTINCT FROM ${excludeRequestKey}`] : []),
    ));

  return row?.total ?? 0;
}

export async function getSerperSpendByPurpose(purpose: string, now = new Date(), excludeRequestKey?: string): Promise<number> {
  const db = getDb();
  const { start, end } = getDayBounds("UTC", now);
  const [row] = await db.select({ total: sql<number>`COALESCE(SUM(${providerRuns.costUsd}), 0)` })
    .from(providerRuns)
    .where(and(
      eq(providerRuns.provider, "serper"),
      gte(providerRuns.startedAt, start),
      sql`${providerRuns.startedAt} < ${end}`,
      sql`${providerRuns.metadata}->>'purpose' = ${purpose}`,
      ...(excludeRequestKey ? [sql`${providerRuns.requestKey} IS DISTINCT FROM ${excludeRequestKey}`] : []),
    ));
  return row?.total ?? 0;
}

export async function getSerperRecoveryState(now = new Date()): Promise<SerperRecoveryState> {
  const db = getDb();
  const apiKey = getSerperEnv().SERPER_API_KEY;
  const currentCredentialFingerprint = apiKey ? createHash("sha256").update(apiKey).digest("hex") : null;
  const rows = await db.select({
    status: providerRuns.status,
    purpose: sql<string | null>`${providerRuns.metadata}->>'purpose'`,
    startedAt: providerRuns.startedAt,
    finishedAt: providerRuns.finishedAt,
    credentialFingerprint: sql<string | null>`${providerRuns.metadata}->>'credentialFingerprint'`,
  })
    .from(providerRuns)
    .where(and(
      eq(providerRuns.provider, "serper"),
      sql`(${providerRuns.metadata}->>'failureKind' IN ('billing', 'authentication') OR (${providerRuns.metadata}->>'purpose' = 'recovery_probe' AND ${providerRuns.status} <> 'budget_blocked'))`,
    ))
    .orderBy(desc(providerRuns.startedAt))
    .limit(1);
  return resolveSerperRecoveryState({ latest: rows[0], currentCredentialFingerprint, now });
}

export async function getGlobalSerperSpendToday(now = new Date(), excludeRequestKey?: string): Promise<number> {
  const db = getDb();
  const { start, end } = getDayBounds("UTC", now);
  const [row] = await db.select({ total: sql<number>`COALESCE(SUM(${providerRuns.costUsd}), 0)` })
    .from(providerRuns)
    .where(and(
      eq(providerRuns.provider, "serper"),
      gte(providerRuns.startedAt, start),
      sql`${providerRuns.startedAt} < ${end}`,
      ...(excludeRequestKey ? [sql`${providerRuns.requestKey} IS DISTINCT FROM ${excludeRequestKey}`] : []),
    ));
  return row?.total ?? 0;
}

export async function getSerperCostDiagnostics(input: {
  dailyCapUsd: number;
  operatorProvidedBalanceUsd?: number;
  now?: Date;
}): Promise<SerperCostDiagnostics> {
  const db = getDb();
  const now = input.now ?? new Date();
  const today = getDayBounds("UTC", now);
  const rollingStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db.select({
    status: providerRuns.status,
    startedAt: providerRuns.startedAt,
    costUsd: providerRuns.costUsd,
    itemsReturned: providerRuns.itemsReturned,
    metadata: providerRuns.metadata,
  }).from(providerRuns).where(and(
    eq(providerRuns.provider, "serper"),
    gte(providerRuns.startedAt, rollingStart),
  ));
  const recoveryCandidates = await db.select({ processingMetrics: rawCandidates.processingMetrics })
    .from(rawCandidates)
    .where(and(
      eq(rawCandidates.engineType, "maps_fast"),
      gte(rawCandidates.discoveredAt, rollingStart),
      sql`${rawCandidates.processingMetrics}->>'websiteRecoveryProvider' = 'serper'`,
    ));

  const purposeNames = [
    "google_serp_discovery",
    "linkedin_owner_discovery",
    "maps_fast_website_recovery",
    "maps_deep_enrichment",
    "recovery_probe",
  ];
  const purposes = Object.fromEntries(purposeNames.map((purpose) => [purpose, {
    queriesToday: 0,
    successfulQueriesToday: 0,
    estimatedBillableAttemptsToday: 0,
    spendTodayUsd: 0,
    providerResultsToday: 0,
    queriesRolling30Days: 0,
    successfulQueriesRolling30Days: 0,
    rolling30DaySpendUsd: 0,
  }])) as Record<string, SerperPurposeUsageDiagnostics>;
  let spendTodayUsd = 0;
  let rolling30DaySpendUsd = 0;
  let estimatedBillableAttemptsToday = 0;
  let recoveryAttempts = 0;
  let recoveredWebsites = 0;
  let recoveredWithEmail = 0;
  let recoveredValidEmails = 0;
  let recoveredImports = 0;
  let validEmailAttributionComplete = true;
  let importAttributionComplete = true;

  for (const candidate of recoveryCandidates) {
    const metrics = candidate.processingMetrics as Record<string, unknown> | null;
    if (!metrics || metrics.websiteRecoveryProvider !== "serper") continue;
    recoveryAttempts += Number(metrics.websiteRecoveryAttempted ?? 0);
    if (Number(metrics.websiteRecoverySucceeded ?? 0) <= 0) continue;
    recoveredWebsites += 1;
    if (metrics.websiteEmailAttributionComplete === true && Number(metrics.websiteEmailsFound ?? 0) > 0) recoveredWithEmail += 1;
    if (typeof metrics.websiteValidEmails === "number") recoveredValidEmails += metrics.websiteValidEmails;
    else validEmailAttributionComplete = false;
    if (typeof metrics.websiteImported === "number") recoveredImports += metrics.websiteImported;
    else importAttributionComplete = false;
  }

  for (const row of rows) {
    const costUsd = Number(row.costUsd ?? 0);
    const startedAt = row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt);
    const metadata = row.metadata as Record<string, unknown>;
    const purpose = typeof metadata.purpose === "string" ? metadata.purpose : "unknown";
    const calls = Number(metadata.httpAttempts ?? (costUsd > 0 ? Math.ceil(costUsd / SERPER_ESTIMATED_COST_PER_QUERY_USD) : 0));
    rolling30DaySpendUsd += costUsd;
    if (purpose in purposes) {
      const usage = purposes[purpose]!;
      usage.rolling30DaySpendUsd += costUsd;
      if (row.status !== "budget_blocked") usage.queriesRolling30Days += 1;
      if (row.status === "completed") usage.successfulQueriesRolling30Days += 1;
    }
    if (startedAt < today.start || startedAt >= today.end) continue;

    spendTodayUsd += costUsd;
    estimatedBillableAttemptsToday += Number.isFinite(calls) ? calls : 0;
    if (purpose in purposes) {
      const usage = purposes[purpose]!;
      if (row.status !== "budget_blocked") usage.queriesToday += 1;
      if (row.status === "completed") usage.successfulQueriesToday += 1;
      usage.estimatedBillableAttemptsToday += Number.isFinite(calls) ? calls : 0;
      usage.spendTodayUsd += costUsd;
      usage.providerResultsToday += row.itemsReturned;
    }
  }

  const rollingAverageDailySpendUsd = rolling30DaySpendUsd / 30;
  const operatorProvidedBalanceUsd = input.operatorProvidedBalanceUsd ?? null;
  const projectedDailySpendUsd = rollingAverageDailySpendUsd > 0 ? rollingAverageDailySpendUsd : input.dailyCapUsd;
  const mapsRecoveryCostUsd = purposes.maps_fast_website_recovery!.rolling30DaySpendUsd;
  return {
    dailyCapUsd: input.dailyCapUsd,
    spendTodayUsd,
    budgetRemainingUsd: Math.max(0, input.dailyCapUsd - spendTodayUsd),
    projected15DayMaxSpendUsd: input.dailyCapUsd * 15,
    projected30DayMaxSpendUsd: input.dailyCapUsd * 30,
    rolling30DaySpendUsd,
    rollingAverageDailySpendUsd,
    projectedBalanceLifetimeDays: operatorProvidedBalanceUsd === null || projectedDailySpendUsd <= 0
      ? null
      : operatorProvidedBalanceUsd / projectedDailySpendUsd,
    operatorProvidedBalanceUsd,
    estimatedBillableAttemptsToday,
    estimatedMaxDailyAttempts: Math.floor(input.dailyCapUsd / SERPER_ESTIMATED_COST_PER_QUERY_USD),
    purposes,
    mapsFastRecovery: {
      attempts: recoveryAttempts,
      succeeded: recoveredWebsites,
      recoveredWithEmail,
      recoveredValidEmails: validEmailAttributionComplete ? recoveredValidEmails : null,
      recoveredImports: importAttributionComplete ? recoveredImports : null,
      costPerRecoveredWebsiteUsd: recoveredWebsites > 0 ? mapsRecoveryCostUsd / recoveredWebsites : null,
      costPerValidEmailUsd: validEmailAttributionComplete && recoveredValidEmails > 0 ? mapsRecoveryCostUsd / recoveredValidEmails : null,
      costPerConfirmedImportUsd: importAttributionComplete && recoveredImports > 0 ? mapsRecoveryCostUsd / recoveredImports : null,
    },
  };
}

/** Real `provider_runs` rows from the last `sinceHours`, folded into `evaluateProviderHealth`'s `ProviderUsageStats` shape (Gate E autopilot cron — feeds real per-engine provider health into `runAutopilotTick`, replacing the previously-hardcoded `"unknown"`). */
export async function getRecentProviderUsage(workspaceId: string, provider: string, sinceHours = 24, after?: Date | null): Promise<ProviderUsageStats> {
  const db = getDb();
  const rollingSince = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const since = after && after > rollingSince ? after : rollingSince;
  const rows = await db
    .select({ status: providerRuns.status, itemsReturned: providerRuns.itemsReturned, costUsd: providerRuns.costUsd })
    .from(providerRuns)
    .where(and(
      eq(providerRuns.workspaceId, workspaceId),
      eq(providerRuns.provider, provider),
      ne(providerRuns.operation, "economic_pacing_state"),
      gte(providerRuns.startedAt, since),
    ));

  let items = 0;
  let errors = 0;
  let costUsd = 0;
  for (const row of rows) {
    if (row.status !== "succeeded" && row.status !== "ingested" && row.status !== "completed" && row.status !== "failed" && row.status !== "aborted" && row.status !== "timed_out") continue;
    items += row.itemsReturned;
    costUsd += row.costUsd;
    if (row.status === "failed" || row.status === "aborted" || row.status === "timed_out") errors += 1;
  }
  const terminalRows = rows.filter((row) => ["succeeded", "ingested", "completed", "failed", "aborted", "timed_out"].includes(row.status));
  return { calls: terminalRows.length, items, errors, totalLatencyMs: 0, costUsd, quotaRemaining: null };
}
