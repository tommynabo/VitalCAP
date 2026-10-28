import { sql } from "drizzle-orm";
import { PROVIDER_DEFERRED_JOB_ERROR_PREFIX } from "@/domain/discovery/types";
import {
  getAdaptiveProcessingMaxJobs,
  getDiscoveryBackpressureMultiplier,
  getProcessingHealthState,
  isWatchdogQueuePauseResumeEligible,
} from "@/services/autopilot/watchdog-pause-policy";
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
    discoveryProcessing: number;
    discoveryStaleLocks: number;
    processingPending: number;
    processingProcessing: number;
    processingStaleLocks: number;
    manualProviderReconciliations: number;
  };
  processing: {
    pending: number;
    oldPending: number;
    oldestAgeMinutes: number | null;
    completedRecent: number;
    failedRecent: number;
    timedOutRecent: number;
    enqueuedRecent: number;
    drainRatePerHour: number;
    adaptiveMaxJobs: number;
    discoveryBackpressureMultiplier: number;
    healthState: "healthy" | "healthy_draining" | "stalled";
    watchdogPauseRequired: boolean;
    watchdogAutoResumeEligible: boolean;
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
  workspaceId: string;
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
          WHERE failure.workspace_id = run.workspace_id AND failure.provider = run.provider
            AND failure.status IN ('failed', 'aborted', 'timed_out')
          ORDER BY COALESCE(failure.finished_at, failure.started_at) DESC
          LIMIT 1
        ) AS last_failure_class
      FROM provider_runs run
      WHERE run.provider IN ('apify', 'serper') AND run.workspace_id = ${input.workspaceId}::uuid
      GROUP BY run.provider, run.workspace_id
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
      WHERE settings.workspace_id = ${input.workspaceId}::uuid
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
        WHERE workspace_id = ${input.workspaceId}::uuid
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
          WHERE job.status = 'pending' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${input.now.toISOString()}::timestamptz)
            AND LEFT(COALESCE(job.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) <> ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX})::int AS due_pending_discovery,
        (SELECT COUNT(*) FROM discovery_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'pending' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND (job.next_attempt_at > ${input.now.toISOString()}::timestamptz
              OR LEFT(COALESCE(job.last_error, ''), ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX.length}) = ${PROVIDER_DEFERRED_JOB_ERROR_PREFIX}))::int AS deferred_discovery,
        (SELECT COUNT(*) FROM discovery_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'processing' AND campaign.workspace_id = ${input.workspaceId}::uuid)::int AS discovery_processing,
        (SELECT COUNT(*) FROM discovery_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'processing' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND job.locked_at < ${new Date(input.now.getTime() - 15 * 60_000).toISOString()}::timestamptz)::int AS discovery_stale_locks,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'pending' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${input.now.toISOString()}::timestamptz))::int AS processing_pending,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'pending' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${input.now.toISOString()}::timestamptz)
            AND job.created_at < ${new Date(input.now.getTime() - 30 * 60_000).toISOString()}::timestamptz)::int AS processing_old_pending,
        (SELECT EXTRACT(EPOCH FROM (${input.now.toISOString()}::timestamptz - MIN(job.created_at))) / 60
          FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'pending' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${input.now.toISOString()}::timestamptz)) AS processing_oldest_age_minutes,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'completed' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND job.updated_at >= ${new Date(input.now.getTime() - 30 * 60_000).toISOString()}::timestamptz)::int AS processing_completed_recent,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status IN ('pending', 'dead_letter') AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND job.updated_at >= ${new Date(input.now.getTime() - 30 * 60_000).toISOString()}::timestamptz
            AND job.last_error IS NOT NULL AND job.last_error NOT ILIKE '%budget%'
            AND job.last_error NOT ILIKE '%raw request cap%')::int AS processing_failed_recent,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status IN ('pending', 'dead_letter') AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND job.updated_at >= ${new Date(input.now.getTime() - 30 * 60_000).toISOString()}::timestamptz
            AND (job.last_error ILIKE '%PROCESSING_JOB_TIMEOUT%'
              OR job.last_error ILIKE '%Processing job exceeded%'
              OR job.last_error ILIKE '%Processing cron work exceeded%')
            AND job.last_error NOT ILIKE '%budget%'
            AND job.last_error NOT ILIKE '%raw request cap%')::int AS processing_timed_out_recent,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE campaign.workspace_id = ${input.workspaceId}::uuid
            AND job.created_at >= ${new Date(input.now.getTime() - 30 * 60_000).toISOString()}::timestamptz)::int AS processing_enqueued_recent,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'processing' AND campaign.workspace_id = ${input.workspaceId}::uuid)::int AS processing_processing,
        (SELECT COUNT(*) FROM processing_jobs job JOIN campaigns campaign ON campaign.id = job.campaign_id
          WHERE job.status = 'processing' AND campaign.workspace_id = ${input.workspaceId}::uuid
            AND job.locked_at < ${new Date(input.now.getTime() - 15 * 60_000).toISOString()}::timestamptz)::int AS processing_stale_locks,
        (SELECT COUNT(*) FROM provider_runs run WHERE run.workspace_id = ${input.workspaceId}::uuid
          AND run.status = 'manual_reconciliation_required')::int AS manual_provider_reconciliations
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
  const processingSignals = {
    oldDueDiscovery: count(queue?.due_pending_discovery),
    deferredDiscovery: count(queue?.deferred_discovery),
    oldProcessing: count(queue?.processing_old_pending),
    staleDiscoveryLocks: count(queue?.discovery_stale_locks),
    staleProcessingLocks: count(queue?.processing_stale_locks),
    manualReconciliations: count(queue?.manual_provider_reconciliations),
    processingPending: count(queue?.processing_pending),
    processingCompletedRecent: count(queue?.processing_completed_recent),
    processingFailedRecent: count(queue?.processing_failed_recent),
    processingTimedOutRecent: count(queue?.processing_timed_out_recent),
    processingEnqueuedRecent: count(queue?.processing_enqueued_recent),
  };
  const processingHealthState = getProcessingHealthState(processingSignals);
  const watchdogAutoResumeEligible = autopilot?.only_pause_reason === "queue_health"
    && count(autopilot?.system_paused_count) > 0
    && isWatchdogQueuePauseResumeEligible(processingSignals);
  return {
    providers,
    autopilotEffectiveState,
    systemPaused: count(autopilot?.system_paused_count) > 0,
    systemPauseReason,
    queue: {
      duePendingDiscovery: count(queue?.due_pending_discovery),
      deferredDiscovery: count(queue?.deferred_discovery),
      discoveryProcessing: count(queue?.discovery_processing),
      discoveryStaleLocks: count(queue?.discovery_stale_locks),
      processingPending: count(queue?.processing_pending),
      processingProcessing: count(queue?.processing_processing),
      processingStaleLocks: count(queue?.processing_stale_locks),
      manualProviderReconciliations: count(queue?.manual_provider_reconciliations),
    },
    processing: {
      pending: processingSignals.processingPending ?? 0,
      oldPending: processingSignals.oldProcessing,
      oldestAgeMinutes: queue?.processing_oldest_age_minutes !== null
        && queue?.processing_oldest_age_minutes !== undefined
        && Number.isFinite(Number(queue.processing_oldest_age_minutes))
        ? Number(queue?.processing_oldest_age_minutes)
        : null,
      completedRecent: processingSignals.processingCompletedRecent ?? 0,
      failedRecent: processingSignals.processingFailedRecent ?? 0,
      timedOutRecent: processingSignals.processingTimedOutRecent ?? 0,
      enqueuedRecent: processingSignals.processingEnqueuedRecent ?? 0,
      drainRatePerHour: (processingSignals.processingCompletedRecent ?? 0) * 2,
      adaptiveMaxJobs: getAdaptiveProcessingMaxJobs(processingSignals),
      discoveryBackpressureMultiplier: getDiscoveryBackpressureMultiplier(processingSignals),
      healthState: processingHealthState,
      watchdogPauseRequired: processingHealthState === "stalled",
      watchdogAutoResumeEligible,
    },
  };
}