import { sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/neon/db";
import { buildInstantEligibleCandidatesQuery } from "@/infrastructure/neon/repositories/instantly-eligible-candidates";
import { getDeliveryEnv } from "@/lib/config/env";
import { getDayBounds } from "@/lib/time/day-bounds";
import { AUTO_SEND_ENABLED } from "@/services/setter/autonomy-policy";

const PROVIDER_STATUSES = [
  "starting",
  "queued",
  "running",
  "succeeded",
  "ingesting",
  "ingested",
  "completed",
  "failed",
  "aborted",
  "timed_out",
  "budget_blocked",
  "manual_reconciliation_required",
] as const;

const MATERIALIZED_STATUSES = new Set<string>(["ingested", "completed"]);
const FAILURE_STATUSES = ["failed", "aborted", "timed_out"] as const satisfies readonly ProviderStatus[];
const ENGINE_TYPES = ["maps_fast", "maps_deep", "google_serp", "linkedin_owner"] as const;
const IMPORT_STATUSES = [
  "eligible",
  "instantly_queued",
  "instantly_added",
  "skipped_existing",
  "deferred",
  "deferred_due_to_plan_limit",
  "failed",
  "needs_campaign_move",
  "reconciliation_required",
] as const;

type RawRow = Record<string, unknown>;
type ProviderStatus = typeof PROVIDER_STATUSES[number];

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function formatLocalDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function emptyStatusCounts() {
  return Object.fromEntries(PROVIDER_STATUSES.map((status) => [status, {
    runs: 0,
    itemsRequested: 0,
    itemsReturned: 0,
  }])) as Record<ProviderStatus, { runs: number; itemsRequested: number; itemsReturned: number }>;
}

function aggregateProviderRuns(rows: RawRow[]) {
  const byStatus = emptyStatusCounts();
  const byEngine: Record<string, { runs: number; itemsRequested: number; itemsReturned: number; rawCandidatesLinked: number }> =
    Object.fromEntries([...ENGINE_TYPES, "unknown"].map((engine) => [engine, {
      runs: 0,
      itemsRequested: 0,
      itemsReturned: 0,
      rawCandidatesLinked: 0,
    }]));
  const byProviderEngineStatus = rows.map((row) => ({
    provider: String(row.provider),
    operation: String(row.operation),
    engine: String(row.engine_type || "unknown"),
    status: String(row.status),
    runs: count(row.runs),
    itemsRequested: count(row.items_requested),
    itemsReturned: count(row.items_returned),
    rawCandidatesLinked: count(row.raw_candidates_linked),
  }));

  let totalRuns = 0;
  let itemsRequested = 0;
  let itemsReturned = 0;
  let rawCandidatesLinked = 0;
  let successfulItemsRequested = 0;
  let successfulItemsReturned = 0;
  let successfulRawCandidatesLinked = 0;
  let failedItemsRequested = 0;

  for (const row of byProviderEngineStatus) {
    const engine = (ENGINE_TYPES as readonly string[]).includes(row.engine) ? row.engine : "unknown";
    totalRuns += row.runs;
    itemsRequested += row.itemsRequested;
    itemsReturned += row.itemsReturned;
    rawCandidatesLinked += row.rawCandidatesLinked;

    const engineTotals = byEngine[engine]!;
    engineTotals.runs += row.runs;
    engineTotals.itemsRequested += row.itemsRequested;
    engineTotals.itemsReturned += row.itemsReturned;
    engineTotals.rawCandidatesLinked += row.rawCandidatesLinked;

    if ((PROVIDER_STATUSES as readonly string[]).includes(row.status)) {
      const statusTotals = byStatus[row.status as ProviderStatus];
      statusTotals.runs += row.runs;
      statusTotals.itemsRequested += row.itemsRequested;
      statusTotals.itemsReturned += row.itemsReturned;
    }
    if (MATERIALIZED_STATUSES.has(row.status)) {
      successfulItemsRequested += row.itemsRequested;
      successfulItemsReturned += row.itemsReturned;
      successfulRawCandidatesLinked += row.rawCandidatesLinked;
    }
    if ((FAILURE_STATUSES as readonly string[]).includes(row.status)) failedItemsRequested += row.itemsRequested;
  }

  const successfulReturnedNotMaterialized = Math.max(0, successfulItemsReturned - successfulRawCandidatesLinked);
  const failedRunCount = FAILURE_STATUSES.reduce((sum, status) => sum + byStatus[status].runs, 0);
  const requestToRawRootCause = totalRuns === 0
    ? "NO_PROVIDER_RUNS"
    : itemsReturned > rawCandidatesLinked
      ? "UNKNOWN"
      : failedItemsRequested > 0 || failedRunCount > 0
        ? "PROVIDER_FAILURES"
        : rate(itemsReturned, itemsRequested) !== null && rate(itemsReturned, itemsRequested)! < 0.5
          ? "LOW_PROVIDER_RETURN"
          : itemsReturned === rawCandidatesLinked
            ? "NORMAL_PROVIDER_BEHAVIOR"
            : "UNKNOWN";

  return {
    totalRuns,
    itemsRequested,
    itemsReturned,
    rawCandidatesLinked,
    requestToReturnRate: rate(itemsReturned, itemsRequested),
    byStatus,
    byProviderEngineStatus,
    byEngine,
    successfulItemsRequested,
    successfulItemsReturned,
    successfulRawCandidatesLinked,
    returnedWithoutRawCandidate: Math.max(0, itemsReturned - rawCandidatesLinked),
    successfulReturnedNotMaterialized,
    successfulReturnedToRawRate: rate(successfulRawCandidatesLinked, successfulItemsReturned),
    rawCandidateDuplicatesSuppressed: null,
    requestToRawRootCause,
    requestedNotReturned: Math.max(0, itemsRequested - itemsReturned),
  };
}

function aggregateUnprocessedRaw(row?: RawRow) {
  const total = count(row?.total);
  const withProcessingJob = count(row?.with_processing_job);
  const withoutProcessingJob = count(row?.without_processing_job);
  const pending = count(row?.pending);
  const processing = count(row?.processing);
  const failed = count(row?.failed);
  const deadLetter = count(row?.dead_letter);
  const completed = count(row?.completed);
  const completedJobButRawStillUnprocessed = count(row?.completed_job_but_raw_unprocessed);
  const currentlyLocked = count(row?.currently_locked);
  const leaseExpiredRetryable = count(row?.lease_expired_retryable);
  const staleLocked = count(row?.stale_locked);
  const orphanCount = count(row?.orphan_count);

  const rootCause = total === 0
    ? "NO_BUG"
    : staleLocked > 0 || leaseExpiredRetryable > 0
      ? "LOCK_STALL"
      : deadLetter > 0
        ? "DEADLETTER_BUG"
        : failed > 0
          ? "FAILED_JOB_BACKLOG"
          : withoutProcessingJob > 0 || completedJobButRawStillUnprocessed > 0 || orphanCount > 0
            ? "ORPHAN_JOB_BUG"
            : "NO_BUG";

  return {
    total,
    oldestAgeMinutes: row?.oldest_age_minutes == null ? null : count(row.oldest_age_minutes),
    withProcessingJob,
    withoutProcessingJob,
    jobStatuses: { pending, processing, failed, dead_letter: deadLetter, completed },
    completedJobButRawStillUnprocessed,
    currentlyLocked,
    leaseExpiredRetryable,
    orphanCount,
    orphanProcessingGap: orphanCount > 0 ? "YES" : total > 0 ? "NO" : "UNKNOWN",
    rootCause,
  };
}

function parseJsonCounts(value: unknown): Record<string, number> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, count(item)]));
}

function aggregateInstantlyToday(row?: RawRow) {
  const eligibleAccounts = count(row?.eligible_accounts);
  const eligibleWithImportRow = count(row?.eligible_with_import_row);
  const eligibleWithoutImportRow = count(row?.eligible_without_import_row);
  const accountStatusCounts = parseJsonCounts(row?.eligible_account_statuses);
  const statuses = Object.fromEntries(IMPORT_STATUSES.map((status) => [status, accountStatusCounts[status] ?? 0])) as
    Record<typeof IMPORT_STATUSES[number], number>;
  const alreadyRepresentedByNormalizedEmail = count(row?.already_represented_by_email);
  const representedAccounts = count(row?.already_represented_accounts_by_email);
  const importDeferred = statuses.deferred + statuses.deferred_due_to_plan_limit;
  const importFailed = statuses.failed;
  const needsCampaignMove = statuses.needs_campaign_move;
  const reconciliationRequired = statuses.reconciliation_required;

  let rootCause = "UNKNOWN";
  if (eligibleAccounts > 0) {
    if (representedAccounts >= eligibleAccounts) rootCause = "ALREADY_REPRESENTED";
    else if (reconciliationRequired > 0) rootCause = "RECONCILIATION";
    else if (needsCampaignMove > 0) rootCause = "NEEDS_CAMPAIGN_MOVE";
    else if (importFailed > 0) rootCause = "FAILED";
    else if (importDeferred > 0) rootCause = "DEFERRED";
    else if (eligibleWithoutImportRow > 0) rootCause = "NO_IMPORT_ROW";
    else if (eligibleWithImportRow > 0) rootCause = "ATTRIBUTION_ONLY";
  }

  return {
    eligibleAccounts,
    withImportRow: eligibleWithImportRow,
    withoutImportRow: eligibleWithoutImportRow,
    statuses,
    alreadyRepresentedByNormalizedEmail,
    alreadyRepresentedAccountsByNormalizedEmail: representedAccounts,
    eligibleEmailsWithoutLocalImportRow: count(row?.eligible_emails_without_import_row),
    genuinelyNewEligibleEmailWithoutRepresentation: null,
    externalRepresentationLookupPerformed: false,
    importRowsCreatedToday: count(row?.import_rows_created_today),
    importRowsCreatedTodayByStatus: parseJsonCounts(row?.import_rows_created_today_by_status),
    circuitOpen: row?.circuit_open === true,
    rootCause,
  };
}

function classifyRequestToRawRootCause(providerRuns: ReturnType<typeof aggregateProviderRuns>): string {
  return providerRuns.requestToRawRootCause;
}

export type ProductivityDiagnosticsStage = "timezone" | "provider_runs" | "unprocessed_raw" | "instantly_today";

export class ProductivityDiagnosticsStageError extends Error {
  readonly stage: ProductivityDiagnosticsStage;
  readonly sqlState: string | null;
  readonly errorClass: string;

  constructor(stage: ProductivityDiagnosticsStage, originalError: unknown) {
    super("Productivity diagnostics query failed");
    this.name = "ProductivityDiagnosticsStageError";
    this.stage = stage;
    this.sqlState = getSafeSqlState(originalError);
    this.errorClass = getSafeErrorClass(originalError);
  }
}

function getSafeSqlState(error: unknown): string | null {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const properties = current as { code?: unknown; sqlState?: unknown; sqlstate?: unknown; cause?: unknown };
    for (const value of [properties.code, properties.sqlState, properties.sqlstate]) {
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value;
    }
    current = properties.cause;
  }
  return null;
}

function getSafeErrorClass(error: unknown): string {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const name = Object.getPrototypeOf(current)?.constructor?.name;
    if (typeof name === "string" && name !== "Error" && name !== "Object" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      return name;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return "Error";
}

async function runDiagnosticStage<T>(stage: ProductivityDiagnosticsStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ProductivityDiagnosticsStageError(stage, error);
  }
}

export async function getProductivityDiagnostics(workspaceId: string, now = new Date()) {
  const db = getDb();
  const settingsResult = await runDiagnosticStage("timezone", () => db.execute(sql`
      SELECT COALESCE(timezone, 'Europe/Madrid') AS timezone
      FROM autopilot_settings
      WHERE workspace_id = ${workspaceId}::uuid
      LIMIT 1
    `));
  const [settings] = settingsResult.rows as RawRow[];
  const timezone = typeof settings?.timezone === "string" ? settings.timezone : "Europe/Madrid";
  const dayBounds = getDayBounds(timezone, now);
  const providerCampaignId = getDeliveryEnv().INSTANTLY_CAMPAIGN_ID;

  const providerResult = await runDiagnosticStage("provider_runs", () => db.execute(sql`
      WITH bounds AS (
        SELECT ${workspaceId}::uuid AS workspace_id,
          ${dayBounds.start.toISOString()}::timestamptz AS day_start,
          ${now.toISOString()}::timestamptz AS now_at
      ), run_scope AS (
        SELECT run.id, run.workspace_id, run.provider, run.operation, run.status,
          run.items_requested, run.items_returned,
          COALESCE(NULLIF(run.metadata->>'engineType', ''), campaign.engine_type, 'unknown') AS engine_type,
          run.metadata->>'discoveryJobId' AS discovery_job_id
        FROM provider_runs run
        CROSS JOIN bounds
        LEFT JOIN campaigns campaign ON campaign.id = run.campaign_id
          AND campaign.workspace_id = run.workspace_id
        WHERE run.workspace_id = bounds.workspace_id
          AND run.provider IN ('apify', 'serper')
          AND run.started_at >= bounds.day_start
          AND run.started_at < bounds.now_at
      ), run_job_counts AS (
        SELECT discovery_job_id, COUNT(*)::int AS run_count
        FROM run_scope
        WHERE discovery_job_id IS NOT NULL
        GROUP BY discovery_job_id
      ), raw_links AS (
        SELECT raw.id AS raw_id, run.id AS provider_run_id
        FROM raw_candidates raw
        JOIN campaigns raw_campaign ON raw_campaign.id = raw.campaign_id
        JOIN bounds ON bounds.workspace_id = raw_campaign.workspace_id
        JOIN run_scope run ON run.id = raw.provider_run_id
        WHERE raw.provider_run_id IS NOT NULL
        UNION
        SELECT raw.id AS raw_id, run.id AS provider_run_id
        FROM raw_candidates raw
        JOIN campaigns raw_campaign ON raw_campaign.id = raw.campaign_id
        JOIN bounds ON bounds.workspace_id = raw_campaign.workspace_id
        JOIN run_scope run ON run.discovery_job_id = raw.discovery_job_id::text
        JOIN run_job_counts lineage ON lineage.discovery_job_id = run.discovery_job_id
          AND lineage.run_count = 1
        WHERE raw.provider_run_id IS NULL
      ), linked_by_run AS (
        SELECT provider_run_id, COUNT(DISTINCT raw_id)::int AS raw_candidates_linked
        FROM raw_links
        GROUP BY provider_run_id
      )
      SELECT run.provider, run.operation, run.engine_type, run.status,
        COUNT(*)::int AS runs,
        COALESCE(SUM(run.items_requested), 0)::int AS items_requested,
        COALESCE(SUM(run.items_returned), 0)::int AS items_returned,
        COALESCE(SUM(linked.raw_candidates_linked), 0)::int AS raw_candidates_linked
      FROM run_scope run
      LEFT JOIN linked_by_run linked ON linked.provider_run_id = run.id
      GROUP BY run.provider, run.operation, run.engine_type, run.status
    `));
  const unprocessedResult = await runDiagnosticStage("unprocessed_raw", () => db.execute(sql`
      WITH bounds AS (
        SELECT ${workspaceId}::uuid AS workspace_id,
          ${dayBounds.start.toISOString()}::timestamptz AS day_start,
          ${now.toISOString()}::timestamptz AS now_at
      ), today_raw AS (
        SELECT raw.id, raw.discovered_at
        FROM raw_candidates raw
        JOIN campaigns campaign ON campaign.id = raw.campaign_id
        CROSS JOIN bounds
        WHERE campaign.workspace_id = bounds.workspace_id
          AND raw.discovered_at >= bounds.day_start
          AND raw.discovered_at < bounds.now_at
          AND raw.processed = false
      ), jobs_by_raw AS (
        SELECT raw.id AS raw_id,
          COUNT(job.id)::int AS job_count,
          BOOL_OR(job.status = 'pending') AS has_pending,
          BOOL_OR(job.status = 'processing') AS has_processing,
          BOOL_OR(job.status = 'failed') AS has_failed,
          BOOL_OR(job.status = 'dead_letter' OR dead_letter.id IS NOT NULL) AS has_dead_letter,
          BOOL_OR(job.status = 'completed') AS has_completed,
          BOOL_OR(job.status = 'pending' AND job.attempt_count < job.max_attempts) AS retryable_pending,
          BOOL_OR(job.status = 'processing' AND job.attempt_count < job.max_attempts) AS retryable_processing,
          BOOL_OR(job.status = 'processing' AND job.locked_at >= bounds.now_at - INTERVAL '5 minutes') AS currently_locked,
          BOOL_OR(job.status = 'processing' AND job.locked_at < bounds.now_at - INTERVAL '5 minutes'
            AND job.attempt_count < job.max_attempts) AS lease_expired_retryable,
          BOOL_OR(job.status = 'processing' AND job.locked_at < bounds.now_at - INTERVAL '10 minutes') AS stale_locked
        FROM today_raw raw
        CROSS JOIN bounds
        LEFT JOIN processing_jobs job ON job.type = 'process_raw_candidate'
          AND job.payload->>'rawCandidateId' = raw.id::text
        LEFT JOIN dead_letter_jobs dead_letter ON dead_letter.source_table = 'processing_jobs'
          AND dead_letter.source_job_id = job.id
        GROUP BY raw.id
      )
      SELECT COUNT(*)::int AS total,
        ROUND(EXTRACT(EPOCH FROM (bounds.now_at - MIN(raw.discovered_at))) / 60.0, 2) AS oldest_age_minutes,
        COUNT(*) FILTER (WHERE jobs.job_count > 0)::int AS with_processing_job,
        COUNT(*) FILTER (WHERE jobs.job_count = 0)::int AS without_processing_job,
        COUNT(*) FILTER (WHERE COALESCE(jobs.has_pending, false))::int AS pending,
        COUNT(*) FILTER (WHERE COALESCE(jobs.has_processing, false))::int AS processing,
        COUNT(*) FILTER (WHERE COALESCE(jobs.has_failed, false))::int AS failed,
        COUNT(*) FILTER (WHERE COALESCE(jobs.has_dead_letter, false))::int AS dead_letter,
        COUNT(*) FILTER (WHERE COALESCE(jobs.has_completed, false))::int AS completed,
        COUNT(*) FILTER (WHERE COALESCE(jobs.has_completed, false) AND NOT raw.processed)::int AS completed_job_but_raw_unprocessed,
        COUNT(*) FILTER (WHERE COALESCE(jobs.currently_locked, false))::int AS currently_locked,
        COUNT(*) FILTER (WHERE COALESCE(jobs.lease_expired_retryable, false))::int AS lease_expired_retryable,
        COUNT(*) FILTER (WHERE COALESCE(jobs.stale_locked, false))::int AS stale_locked,
        COUNT(*) FILTER (WHERE jobs.job_count = 0 OR COALESCE(jobs.has_completed, false)
          OR COALESCE(jobs.has_dead_letter, false))::int AS orphan_count
      FROM today_raw raw
      CROSS JOIN bounds
      LEFT JOIN jobs_by_raw jobs ON jobs.raw_id = raw.id
      GROUP BY bounds.now_at
    `));
  const instantlyResult = await runDiagnosticStage("instantly_today", () => db.execute(sql`
      WITH eligible_candidates AS (
        ${buildInstantEligibleCandidatesQuery({
          providerCampaignId,
          workspaceId,
          rawDiscoveredWithin: { start: dayBounds.start, end: now },
          projection: "identity",
          limit: null,
        })}
      ), matched_candidates AS (
        SELECT eligible.account_id, eligible.normalized_email,
          imported.id AS import_id,
          imported.status AS import_status,
          imported.provider_lead_id,
          imported.normalized_email AS imported_email
        FROM eligible_candidates eligible
        LEFT JOIN LATERAL (
          SELECT import.id, import.status, import.provider_lead_id, import.normalized_email
          FROM instantly_lead_imports import
          WHERE import.workspace_id = eligible.workspace_id
            AND import.provider_campaign_id = ${providerCampaignId}
            AND (import.normalized_email = eligible.normalized_email OR import.account_id = eligible.account_id)
          ORDER BY (import.normalized_email = eligible.normalized_email) DESC, import.created_at DESC
          LIMIT 1
        ) imported ON TRUE
      ), account_rollup AS (
        SELECT account_id,
          BOOL_OR(import_id IS NOT NULL) AS has_import_row,
          BOOL_OR(imported_email = normalized_email AND (
            import_status IN ('instantly_added', 'skipped_existing') OR provider_lead_id IS NOT NULL
          )) AS represented_by_email,
          BOOL_OR(import_status = 'eligible') AS eligible,
          BOOL_OR(import_status = 'instantly_queued') AS instantly_queued,
          BOOL_OR(import_status = 'instantly_added') AS instantly_added,
          BOOL_OR(import_status = 'skipped_existing') AS skipped_existing,
          BOOL_OR(import_status = 'deferred') AS deferred,
          BOOL_OR(import_status = 'deferred_due_to_plan_limit') AS deferred_due_to_plan_limit,
          BOOL_OR(import_status = 'failed') AS failed,
          BOOL_OR(import_status = 'needs_campaign_move') AS needs_campaign_move,
          BOOL_OR(import_status = 'reconciliation_required') AS reconciliation_required
        FROM matched_candidates
        GROUP BY account_id
      ), email_rollup AS (
        SELECT normalized_email,
          BOOL_OR(imported_email = normalized_email AND (
            import_status IN ('instantly_added', 'skipped_existing') OR provider_lead_id IS NOT NULL
          )) AS represented
        FROM matched_candidates
        GROUP BY normalized_email
      ), today_imports AS (
        SELECT import.status, COUNT(*)::int AS rows
        FROM instantly_lead_imports import
        JOIN campaigns source_campaign ON source_campaign.id = import.source_campaign_id
          AND source_campaign.workspace_id = ${workspaceId}::uuid
        WHERE import.provider_campaign_id = ${providerCampaignId}
          AND import.created_at >= ${dayBounds.start.toISOString()}::timestamptz
          AND import.created_at < ${now.toISOString()}::timestamptz
        GROUP BY import.status
      )
      SELECT
        (SELECT COUNT(*)::int FROM account_rollup) AS eligible_accounts,
        (SELECT COUNT(*)::int FROM account_rollup WHERE has_import_row) AS eligible_with_import_row,
        (SELECT COUNT(*)::int FROM account_rollup WHERE NOT has_import_row) AS eligible_without_import_row,
        (SELECT COUNT(*)::int FROM account_rollup WHERE represented_by_email) AS already_represented_accounts_by_email,
        (SELECT COUNT(*)::int FROM email_rollup WHERE represented) AS already_represented_by_email,
        (SELECT COUNT(DISTINCT normalized_email)::int FROM matched_candidates
          WHERE imported_email IS DISTINCT FROM normalized_email) AS eligible_emails_without_import_row,
        (SELECT COALESCE(jsonb_object_agg(status, count), '{}'::jsonb)
          FROM (SELECT status, COUNT(*)::int AS count FROM account_rollup
            CROSS JOIN LATERAL (VALUES
              ('eligible', eligible), ('instantly_queued', instantly_queued),
              ('instantly_added', instantly_added), ('skipped_existing', skipped_existing),
              ('deferred', deferred), ('deferred_due_to_plan_limit', deferred_due_to_plan_limit),
              ('failed', failed), ('needs_campaign_move', needs_campaign_move),
              ('reconciliation_required', reconciliation_required)
            ) AS account_status(status, matched)
            WHERE matched
            GROUP BY status
          ) statuses) AS eligible_account_statuses,
        (SELECT COALESCE(SUM(rows), 0)::int FROM today_imports) AS import_rows_created_today,
        (SELECT COALESCE(jsonb_object_agg(status, rows), '{}'::jsonb) FROM today_imports) AS import_rows_created_today_by_status,
        EXISTS (
          SELECT 1 FROM instantly_import_locks lock_row
          WHERE lock_row.provider_campaign_id = ${providerCampaignId}
            AND lock_row.lock_token LIKE 'auth-failure:%'
            AND EXISTS (
              SELECT 1 FROM campaigns campaign
              WHERE campaign.workspace_id = ${workspaceId}::uuid
                AND (
                  campaign.engine_config->>'instantlyCampaignId' = ${providerCampaignId}
                  OR campaign.engine_config->>'providerCampaignId' = ${providerCampaignId}
                  OR EXISTS (
                    SELECT 1 FROM campaign_provider_mappings mapping
                    WHERE mapping.campaign_id = campaign.id
                      AND mapping.provider = 'instantly'
                      AND mapping.provider_campaign_id = ${providerCampaignId}
                      AND mapping.enabled = true
                  )
                )
            )
        ) AS circuit_open
    `));

  const providerRuns = aggregateProviderRuns(providerResult.rows as RawRow[]);
  const unprocessedRaw = aggregateUnprocessedRaw((unprocessedResult.rows as RawRow[])[0]);
  const instantlyToday = aggregateInstantlyToday((instantlyResult.rows as RawRow[])[0]);
  return {
    generatedAt: now.toISOString(),
    timezone,
    localDate: formatLocalDate(now, timezone),
    localDayStart: dayBounds.start.toISOString(),
    localDayEnd: dayBounds.end.toISOString(),
    providerRuns,
    unprocessedRaw,
    instantlyToday,
    instantlyProvider: {
      currentLeads: null,
      contactHeadroom: null,
      monthlyEmailsSent: null,
      monthlyEmailHeadroom: null,
      circuitOpen: instantlyToday.circuitOpen,
      liveProviderTelemetryAvailable: false,
    },
    rootCauses: {
      requestToRaw: classifyRequestToRawRootCause(providerRuns),
      rawProcessing: unprocessedRaw.rootCause,
      eligibleToInstantly: instantlyToday.rootCause,
    },
    autoSendEnabled: AUTO_SEND_ENABLED,
  };
}