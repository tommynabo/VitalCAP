import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getCoreEnv } from "@/lib/config/env";
import { getDb, getNeonSql } from "../db";

export const GLOBAL_DAILY_RAW_CAP_LOCK_KEY = "vitalcap:global-daily-raw-request-cap";

export interface DailyRawRequestCapSnapshot {
  cap: number;
  committedRawRequests: number;
  providerReservedRawRequests: number;
  queuedRawRequests: number;
  remainingRawRequests: number;
  utilization: number;
  blocked: boolean;
  overshootRawRequests: number;
  blockedReason: "daily_raw_request_cap_reached" | null;
}

export interface DailyRawCapDiscoveryOrder {
  campaignId: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  desiredRawCount: number;
}

export interface ReservedDailyRawCapOrder {
  id: string;
  idempotencyKey: string;
  desiredRawCount: number;
}

const dialect = new PgDialect();

export function buildDailyRawRequestCommitmentCtes(now: Date) {
  const nowIso = now.toISOString();
  return sql`
    workspace_day_bounds AS (
      SELECT workspace.id AS workspace_id,
        COALESCE(settings.timezone, 'Europe/Madrid') AS timezone,
        (((${nowIso}::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'Europe/Madrid'))::date)::timestamp
          AT TIME ZONE COALESCE(settings.timezone, 'Europe/Madrid')) AS day_start,
        (((${nowIso}::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'Europe/Madrid'))::date + 1)::timestamp
          AT TIME ZONE COALESCE(settings.timezone, 'Europe/Madrid')) AS day_end
      FROM workspaces workspace
      LEFT JOIN autopilot_settings settings ON settings.workspace_id = workspace.id
    ),
    counted_raw_provider_runs AS (
      SELECT run.id, run.workspace_id, GREATEST(run.items_requested, 0) AS items_requested,
        run.metadata->>'discoveryJobId' AS discovery_job_id
      FROM provider_runs run
      JOIN workspace_day_bounds bounds ON bounds.workspace_id = run.workspace_id
      WHERE run.provider IN ('apify', 'serper')
        AND (
          (run.started_at >= bounds.day_start AND run.started_at < bounds.day_end)
          OR run.status IN ('starting', 'queued', 'running', 'succeeded', 'ingesting')
        )
    ),
    provider_requests_by_discovery_job AS (
      SELECT discovery_job_id, COALESCE(SUM(items_requested), 0)::int AS provider_reserved_raw_requests
      FROM counted_raw_provider_runs
      WHERE discovery_job_id IS NOT NULL
      GROUP BY discovery_job_id
    ),
    raw_provider_commitment AS (
      SELECT COALESCE(SUM(items_requested), 0)::int AS provider_reserved_raw_requests
      FROM counted_raw_provider_runs
    ),
    unrepresented_discovery_commitment AS (
      SELECT COALESCE(SUM(GREATEST(
        CASE WHEN job.payload->>'desiredRawCount' ~ '^[0-9]+$'
          THEN (job.payload->>'desiredRawCount')::int ELSE 0 END
          - COALESCE(represented.provider_reserved_raw_requests, 0),
        0
      )), 0)::int AS queued_raw_requests
      FROM discovery_jobs job
      JOIN campaigns campaign ON campaign.id = job.campaign_id
      LEFT JOIN provider_requests_by_discovery_job represented ON represented.discovery_job_id = job.id::text
      WHERE job.type = 'run_engine_batch'
        AND job.status IN ('pending', 'processing')
        AND (job.status = 'processing' OR job.attempt_count < job.max_attempts)
    ),
    daily_raw_commitment AS (
      SELECT provider.provider_reserved_raw_requests,
        queued.queued_raw_requests,
        provider.provider_reserved_raw_requests + queued.queued_raw_requests AS committed_raw_requests
      FROM raw_provider_commitment provider
      CROSS JOIN unrepresented_discovery_commitment queued
    )
  `;
}

export function buildDailyRawRequestCapSnapshotQuery(now: Date) {
  return sql`
    WITH ${buildDailyRawRequestCommitmentCtes(now)}
    SELECT provider_reserved_raw_requests, queued_raw_requests, committed_raw_requests
    FROM daily_raw_commitment
  `;
}

export function buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery(
  orders: readonly DailyRawCapDiscoveryOrder[],
  cap: number,
  now: Date,
) {
  const inputOrders = orders.map((order, orderIndex) => ({
    campaign_id: order.campaignId,
    type: order.type,
    payload: order.payload,
    idempotency_key: order.idempotencyKey,
    desired_raw_count: Math.max(0, Math.floor(order.desiredRawCount)),
    priority: order.payload.origin === "recovery_probe" ? 0 : 1,
    order_index: orderIndex,
  }));

  return sql`
    WITH ${buildDailyRawRequestCommitmentCtes(now)},
    input_orders AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(inputOrders)}::jsonb) AS input(
        campaign_id uuid,
        type text,
        payload jsonb,
        idempotency_key text,
        desired_raw_count integer,
        priority integer,
        order_index integer
      )
    ),
    eligible_orders AS (
      SELECT input.*
      FROM input_orders input
      WHERE input.desired_raw_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM discovery_jobs existing
          WHERE existing.idempotency_key = input.idempotency_key
            AND existing.status IN ('pending', 'processing')
        )
    ),
    allocated_orders AS (
      SELECT eligible.*,
        GREATEST(0, LEAST(
          eligible.desired_raw_count,
          ${cap} - daily_raw_commitment.committed_raw_requests
            - COALESCE(SUM(eligible.desired_raw_count) OVER (
              ORDER BY eligible.priority, eligible.order_index
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)
        ))::int AS reserved_raw_count
      FROM eligible_orders eligible
      CROSS JOIN daily_raw_commitment
    ),
    inserted_orders AS (
      INSERT INTO discovery_jobs (campaign_id, type, payload, idempotency_key)
      SELECT allocated.campaign_id, allocated.type,
        jsonb_set(allocated.payload, '{desiredRawCount}', to_jsonb(allocated.reserved_raw_count), true),
        allocated.idempotency_key
      FROM allocated_orders allocated
      WHERE allocated.reserved_raw_count > 0
      ON CONFLICT DO NOTHING
      RETURNING id, idempotency_key, payload->>'desiredRawCount' AS desired_raw_count
    )
    SELECT daily_raw_commitment.provider_reserved_raw_requests,
      daily_raw_commitment.queued_raw_requests,
      daily_raw_commitment.committed_raw_requests,
      COALESCE(SUM(inserted_orders.desired_raw_count::int), 0)::int AS newly_reserved_raw_requests,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', inserted_orders.id,
        'idempotencyKey', inserted_orders.idempotency_key,
        'desiredRawCount', inserted_orders.desired_raw_count::int
      )) FILTER (WHERE inserted_orders.id IS NOT NULL), '[]'::jsonb) AS reserved_orders
    FROM daily_raw_commitment
    LEFT JOIN inserted_orders ON TRUE
    GROUP BY daily_raw_commitment.provider_reserved_raw_requests,
      daily_raw_commitment.queued_raw_requests,
      daily_raw_commitment.committed_raw_requests
  `;
}

export async function executeUnderGlobalDailyRawCapLock(query: SQL): Promise<Array<Record<string, unknown>>> {
  const compiled = dialect.sqlToQuery(query);
  const neon = getNeonSql();
  const results = await neon.transaction([
    neon`SELECT pg_advisory_xact_lock(hashtextextended(${GLOBAL_DAILY_RAW_CAP_LOCK_KEY}, 0))`,
    neon.query(compiled.sql, compiled.params),
  ]);
  return results[1] as Array<Record<string, unknown>>;
}

export function buildDailyRawRequestCapSnapshot(
  cap: number,
  committedRawRequests: number,
  providerReservedRawRequests: number,
  queuedRawRequests: number,
): DailyRawRequestCapSnapshot {
  const remainingRawRequests = Math.max(0, cap - committedRawRequests);
  return {
    cap,
    committedRawRequests,
    providerReservedRawRequests,
    queuedRawRequests,
    remainingRawRequests,
    utilization: cap > 0 ? committedRawRequests / cap : 0,
    blocked: remainingRawRequests === 0,
    overshootRawRequests: Math.max(0, committedRawRequests - cap),
    blockedReason: remainingRawRequests === 0 ? "daily_raw_request_cap_reached" : null,
  };
}

export async function getDailyRawRequestCapSnapshot(now = new Date()): Promise<DailyRawRequestCapSnapshot> {
  const cap = getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS;
  const result = await getDb().execute(buildDailyRawRequestCapSnapshotQuery(now));
  const row = result.rows[0] as {
    provider_reserved_raw_requests?: unknown;
    queued_raw_requests?: unknown;
    committed_raw_requests?: unknown;
  } | undefined;
  const providerReservedRawRequests = Number(row?.provider_reserved_raw_requests ?? 0);
  const queuedRawRequests = Number(row?.queued_raw_requests ?? 0);
  return buildDailyRawRequestCapSnapshot(cap, Number(row?.committed_raw_requests ?? 0), providerReservedRawRequests, queuedRawRequests);
}

export async function enqueueDiscoveryOrdersWithinDailyRawCap(
  orders: readonly DailyRawCapDiscoveryOrder[],
  now = new Date(),
): Promise<{ snapshot: DailyRawRequestCapSnapshot; orders: ReservedDailyRawCapOrder[] }> {
  const cap = getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS;
  const rows = await executeUnderGlobalDailyRawCapLock(buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery(orders, cap, now));
  const row = rows[0] as {
    provider_reserved_raw_requests: unknown;
    queued_raw_requests: unknown;
    committed_raw_requests: unknown;
    newly_reserved_raw_requests: unknown;
    reserved_orders: unknown;
  } | undefined;
  const newlyReserved = Number(row?.newly_reserved_raw_requests ?? 0);
  const committedRawRequests = Number(row?.committed_raw_requests ?? 0) + newlyReserved;
  const snapshot = buildDailyRawRequestCapSnapshot(
    cap,
    committedRawRequests,
    Number(row?.provider_reserved_raw_requests ?? 0),
    Number(row?.queued_raw_requests ?? 0) + newlyReserved,
  );
  const reservedOrders = Array.isArray(row?.reserved_orders)
    ? row.reserved_orders as ReservedDailyRawCapOrder[]
    : [];
  return { snapshot, orders: reservedOrders };
}
