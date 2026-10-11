import { sql } from "drizzle-orm";
import { PROVIDER_DEFERRED_JOB_ERROR_PREFIX } from "@/domain/discovery/types";
import { getDb } from "../db";

export interface ProviderHealthDiagnostics {
  recentTerminalCalls: number;
  recentErrors: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureClass: string | null;
  budgetAllowed: boolean;
}

export interface SystemHealthDiagnostics {
  providers: Record<"apify" | "serper", ProviderHealthDiagnostics>;
  autopilotEffectiveState: "running" | "paused" | "system_paused" | "emergency_stopped" | "mixed" | "unknown";
  systemPaused: boolean;
  systemPauseReason: "provider_reconciliation" | "queue_health" | "other" | "mixed" | null;
  queue: {
    duePendingDiscovery: number;
    deferredDiscovery: number;
    processingPending: number;
    staleLocks: number;
    manualProviderReconciliations: number;
  };
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function emptyProviderDiagnostics(budgetAllowed: boolean): ProviderHealthDiagnostics {
  return {
    recentTerminalCalls: 0,
    recentErrors: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureClass: null,
    budgetAllowed,
  };
}

export async function getSystemHealthDiagnostics(input: {
  now: Date;
  mapsDailyBudgetUsd: number;
  serperDailyBudgetUsd: number;
}): Promise<SystemHealthDiagnostics> {
  const db = getDb();
  const recentSince = new Date(input.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [providerResult, budgetResult, autopilotResult, queueResult] = await Promise.all([
    db.execute(sql`
      SELECT run.provider,
        COUNT(*) FILTER (WHERE run.status IN ('succeeded', 'ingested', 'completed', 'failed', 'aborted', 'timed_out')
          AND run.started_at >= ${recentSince}::timestamptz)::int AS recent_terminal_calls,
        COUNT(*) FILTER (WHERE run.status IN ('failed', 'aborted', 'timed_out')
          AND run.started_at >= ${recentSince}::timestamptz)::int AS recent_errors,
        MAX(CASE WHEN run.status IN ('succeeded', 'ingested', 'completed')
          THEN COALESCE(run.finished_at, run.started_at) END) AS last_success_at,
        MAX(CASE WHEN run.status IN ('failed', 'aborted', 'timed_out')
          THEN COALESCE(run.finished_at, run.started_at) END) AS last_failure_at,
        (
          SELECT CASE
            WHEN failure.error ILIKE '%billing%' OR failure.error ILIKE '%payment%' OR failure.error ILIKE '%credit%' THEN 'billing'
            WHEN failure.error ILIKE '%rate limit%' OR failure.error ILIKE '%429%' OR failure.error ILIKE '%quota%' THEN 'rate_limited'
            WHEN failure.error ILIKE '%auth%' OR failure.error ILIKE '%forbidden%' OR failure.error ILIKE '%401%' OR failure.error ILIKE '%403%' THEN 'authentication'
            WHEN failure.error ILIKE '%timeout%' OR failure.error ILIKE '%timed out%' THEN 'timeout'
            ELSE 'provider_error'
          END
          FROM provider_runs failure
          WHERE failure.provider = run.provider AND failure.status IN ('failed', 'aborted', 'timed_out')
          ORDER BY COALESCE(failure.finished_at, failure.started_at) DESC
          LIMIT 1
        ) AS last_failure_class
      FROM provider_runs run
      WHERE run.provider IN ('apify', 'serper')
      GROUP BY run.provider
    `),
    db.execute(sql`
      SELECT settings.workspace_id,
        settings.max_daily_apify_spend_usd,
        settings.timezone,
        COALESCE(SUM(run.cost_usd) FILTER (WHERE run.provider = 'apify'), 0)::float AS apify_spend,
        COALESCE(SUM(run.cost_usd) FILTER (WHERE run.provider = 'serper'), 0)::float AS serper_spend
      FROM autopilot_settings settings
      LEFT JOIN provider_runs run ON run.workspace_id = settings.workspace_id
        AND run.provider IN ('apify', 'serper')
        AND run.started_at >= ((date_trunc('day', ${input.now.toISOString()}::timestamptz AT TIME ZONE settings.timezone)) AT TIME ZONE settings.timezone)
        AND run.started_at < ${input.now.toISOString()}::timestamptz
      GROUP BY settings.workspace_id, settings.max_daily_apify_spend_usd, settings.timezone
    `),
    db.execute(sql`
      WITH states AS (
        SELECT
          CASE
            WHEN emergency_stopped THEN 'emergency_stopped'
            WHEN NOT enabled THEN 'paused'
            WHEN system_paused THEN 'system_paused'
            ELSE 'running'
          END AS effective_state,
          CASE
            WHEN system_pause_reason = 'provider_reconciliation' THEN 'provider_reconciliation'
            WHEN system_pause_reason = 'Queue health deteriorated (watchdog)' THEN 'queue_health'
            ELSE 'other'
          END AS pause_reason
        FROM autopilot_settings
      )
      SELECT COUNT(*)::int AS settings_count,
        COUNT(DISTINCT effective_state)::int AS effective_state_count,
        MIN(effective_state) AS only_effective_state,
        COUNT(*) FILTER (WHERE effective_state = 'running')::int AS running_count,
        COUNT(*) FILTER (WHERE effective_state = 'paused')::int AS paused_count,
        COUNT(*) FILTER (WHERE effective_state = 'system_paused')::int AS system_paused_count,
        COUNT(*) FILTER (WHERE effective_state = 'emergency_stopped')::int AS emergency_stopped_count,
        BOOL_OR(effective_state = 'system_paused') AS system_paused,
        COUNT(DISTINCT pause_reason) FILTER (WHERE effective_state = 'system_paused')::int AS pause_reason_count,
        MIN(pause_reason) FILTER (WHERE effective_state = 'system_paused') AS only_pause_reason
      FROM states
    `),
    db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM discovery_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'pending' AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${input.now.toISOString()}::timestamptz)
            AND LEFT(COALESCE(job.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) <> ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX})::int AS due_pending_discovery,
        (SELECT COUNT(*) FROM discovery_jobs job
          WHERE job.status = 'pending' AND (job.next_attempt_at > ${input.now.toISOString()}::timestamptz
            OR LEFT(COALESCE(job.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) = ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX}))::int AS deferred_discovery,
        (SELECT COUNT(*) FROM processing_jobs job
          WHERE job.status = 'pending' AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${input.now.toISOString()}::timestamptz))::int AS processing_pending,
        ((SELECT COUNT(*) FROM discovery_jobs job WHERE job.status = 'processing'
            AND job.locked_at < ${new Date(input.now.getTime() - 15 * 60_000).toISOString()}::timestamptz)
          + (SELECT COUNT(*) FROM processing_jobs job WHERE job.status = 'processing'
            AND job.locked_at < ${new Date(input.now.getTime() - 15 * 60_000).toISOString()}::timestamptz))::int AS stale_locks,
        (SELECT COUNT(*) FROM provider_runs run WHERE run.status = 'manual_reconciliation_required')::int AS manual_provider_reconciliations
    `),
  ]);

  const budgets = budgetResult.rows as Array<Record<string, unknown>>;
  const budgetAllowed = (provider: "apify" | "serper"): boolean => {
    if (budgets.length === 0) return true;
    return budgets.every((row) => {
      const spend = count(provider === "apify" ? row.apify_spend : row.serper_spend);
      const configuredWorkspaceBudget = provider === "apify" && row.max_daily_apify_spend_usd !== null
        ? count(row.max_daily_apify_spend_usd)
        : Number.POSITIVE_INFINITY;
      const cap = Math.min(
        provider === "apify" ? input.mapsDailyBudgetUsd : input.serperDailyBudgetUsd,
        configuredWorkspaceBudget,
      );
      return spend < cap;
    });
  };

  const providers = {
    apify: emptyProviderDiagnostics(budgetAllowed("apify")),
    serper: emptyProviderDiagnostics(budgetAllowed("serper")),
  };
  for (const row of providerResult.rows as Array<Record<string, unknown>>) {
    const provider = row.provider === "apify" || row.provider === "serper" ? row.provider : null;
    if (!provider) continue;
    providers[provider] = {
      recentTerminalCalls: count(row.recent_terminal_calls),
      recentErrors: count(row.recent_errors),
      lastSuccessAt: asIsoString(row.last_success_at),
      lastFailureAt: asIsoString(row.last_failure_at),
      lastFailureClass: typeof row.last_failure_class === "string" ? row.last_failure_class : null,
      budgetAllowed: providers[provider].budgetAllowed,
    };
  }

  const autopilot = autopilotResult.rows[0] as Record<string, unknown> | undefined;
  const autopilotEffectiveState = count(autopilot?.settings_count) === 0
    ? "unknown"
    : count(autopilot?.effective_state_count) > 1
      ? "mixed"
      : String(autopilot?.only_effective_state) as SystemHealthDiagnostics["autopilotEffectiveState"];
  const reasonCount = count(autopilot?.pause_reason_count);
  const systemPauseReason = !count(autopilot?.system_paused_count)
    ? null
    : reasonCount > 1
      ? "mixed"
      : autopilot?.only_pause_reason === "provider_reconciliation"
        ? "provider_reconciliation"
        : autopilot?.only_pause_reason === "queue_health"
          ? "queue_health"
          : "other";
  const queue = queueResult.rows[0] as Record<string, unknown> | undefined;
  return {
    providers,
    autopilotEffectiveState,
    systemPaused: count(autopilot?.system_paused_count) > 0,
    systemPauseReason,
    queue: {
      duePendingDiscovery: count(queue?.due_pending_discovery),
      deferredDiscovery: count(queue?.deferred_discovery),
      processingPending: count(queue?.processing_pending),
      staleLocks: count(queue?.stale_locks),
      manualProviderReconciliations: count(queue?.manual_provider_reconciliations),
    },
  };
}