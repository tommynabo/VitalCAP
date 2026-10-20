import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildClaimJobsQuery, buildDeadLetterExpiredJobsQuery, buildDeferJobQuery, buildRequeueStaleLockedJobsQuery, buildRecoverableRawProcessingJobsQuery, IDEMPOTENCY_PROBE_RECOVERY_VERSION, MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS, MAX_RECOVERABLE_RAW_PROCESSING_JOBS_PER_TICK } from "./job-queue";

const dialect = new PgDialect();
const claimTime = new Date("2026-10-18T09:00:00.000Z");

function buildDiscoveryClaimQuery(batchSize = 1) {
  return dialect.sqlToQuery(buildClaimJobsQuery("discovery_jobs", {
    workerId: "worker-1",
    batchSize,
    campaignId: "campaign-1",
    requireAutopilot: true,
    leaseMs: 5 * 60 * 1000,
  }, claimTime));
}

describe("job queue SQL builders", () => {
  it("orders eligible recovery probes before other discovery jobs deterministically", () => {
    const query = buildDiscoveryClaimQuery();
    const orderClause = query.sql.slice(query.sql.indexOf("ORDER BY"), query.sql.indexOf("FOR UPDATE"));

    expect(orderClause.replace(/\s+/g, " ").trim()).toBe(
      "ORDER BY CASE WHEN j.payload->>'origin' = 'recovery_probe' THEN 0 ELSE 1 END ASC, j.next_attempt_at ASC NULLS FIRST, j.created_at ASC, j.id ASC",
    );
  });

  it("keeps future recovery retries ineligible under the shared due-time guard", () => {
    const query = buildDiscoveryClaimQuery();
    const whereClause = query.sql.slice(query.sql.indexOf("WHERE"), query.sql.indexOf("ORDER BY"));

    expect(whereClause).toMatch(/j\.next_attempt_at IS NULL OR j\.next_attempt_at <= \$\d+::timestamptz/);
    expect(whereClause).not.toContain("payload->>'origin'");
  });

  it("keeps max-attempt recovery jobs ineligible under the shared attempt guard", () => {
    const query = buildDiscoveryClaimQuery();
    const whereClause = query.sql.slice(query.sql.indexOf("WHERE"), query.sql.indexOf("ORDER BY"));

    expect(whereClause).toContain("j.attempt_count < j.max_attempts");
    expect(whereClause).not.toContain("payload->>'origin'");
  });

  it("leaves normal discovery jobs eligible when no recovery probe is eligible", () => {
    const query = buildDiscoveryClaimQuery();
    const whereClause = query.sql.slice(query.sql.indexOf("WHERE"), query.sql.indexOf("ORDER BY"));

    expect(whereClause).not.toContain("payload->>'origin'");
    expect(query.sql).toContain("CASE WHEN j.payload->>'origin' = 'recovery_probe' THEN 0 ELSE 1 END");
  });

  it("preserves campaign, Autopilot, status, lease, and SKIP LOCKED guards", () => {
    const query = buildDiscoveryClaimQuery();

    expect(query.sql).toContain("c.status = 'active'");
    expect(query.sql).toContain("c.autopilot_enabled = true AND aps.enabled = true AND aps.emergency_stopped = false AND aps.system_paused = false");
    expect(query.sql).toContain("j.campaign_id =");
    expect(query.sql).toContain("j.status IN ('pending', 'processing')");
    expect(query.sql).toContain("j.locked_at + (");
    expect(query.sql).toContain("FOR UPDATE OF j SKIP LOCKED");
  });

  it("limits a single-job discovery claim to at most one row", () => {
    const query = buildDiscoveryClaimQuery(1);
    const limitParameter = Number(query.sql.match(/LIMIT \$(\d+)/)?.[1]);

    expect(Number.isInteger(limitParameter)).toBe(true);
    expect(query.params[limitParameter - 1]).toBe(1);
  });

  it("defers a discovery job without retaining a lock or consuming an attempt", () => {
    const query = dialect.sqlToQuery(buildDeferJobQuery("discovery_jobs", {
      jobId: "job-1",
      workerId: "worker-1",
      nextAttemptAt: new Date("2026-10-11T12:30:00.000Z"),
      reason: "Apify billing unavailable",
    }, new Date("2026-10-11T12:00:00.000Z")));

    expect(query.sql).toContain("SET status = 'pending'");
    expect(query.sql).toContain("locked_at = NULL");
    expect(query.sql).toContain("locked_by = NULL");
    expect(query.sql).toContain("GREATEST(attempt_count - 1, 0)");
    expect(query.sql).toContain("next_attempt_at =");
    expect(query.params).toContain("2026-10-11T12:30:00.000Z");
    expect(query.sql).not.toContain("dead_letter");
  });

  it.each(["discovery_jobs", "processing_jobs"] as const)("writes %s dead letters using the current schema", (table) => {
    const query = dialect.sqlToQuery(buildDeadLetterExpiredJobsQuery(table, 300, "Max attempts exceeded"));

    expect(query.sql).toContain("INSERT INTO dead_letter_jobs (source_table, source_job_id, campaign_id, payload, attempt_count, last_error, created_at)");
    expect(query.sql).toContain("WHERE status = 'processing'");
    expect(query.sql).toContain("locked_at IS NOT NULL");
    expect(query.sql).toContain("locked_at + (");
    expect(query.sql).not.toContain("status = 'pending'");
    expect(query.sql).not.toMatch(/original_payload|final_error/);
    if (table === "processing_jobs") {
      expect(query.sql).toContain("payload->>'recoveryAttempt' IS NOT NULL");
      expect(query.sql).toContain("'disposition', CASE WHEN payload->>'recoveryAttempt' IS NOT NULL OR last_error ~*");
      expect(query.sql).toContain("THEN 'permanent' ELSE 'recoverable' END");
      expect(query.sql).toContain("'recovery_attempt_exhausted'");
    }
  });

  it.each(["discovery_jobs", "processing_jobs"] as const)("requeues only eligible stale %s locks", (table) => {
    const query = dialect.sqlToQuery(
      buildRequeueStaleLockedJobsQuery(
        table,
        new Date("2026-10-09T20:00:00.000Z"),
        new Date("2026-10-09T19:50:00.000Z"),
      ),
    );

    expect(query.sql).toContain(`UPDATE ${table}`);
    expect(query.sql).toContain("status = 'processing'");
    expect(query.sql).toContain("locked_at IS NOT NULL");
    expect(query.sql).toContain("locked_at <");
    expect(query.sql).toContain("attempt_count < max_attempts");
    expect(query.sql).toContain("SET status = 'pending'");
    expect(query.sql).not.toMatch(/attempt_count\s*=|idempotency_key\s*=|next_attempt_at\s*=/);
    expect(query.sql).not.toMatch(/completed|dead_letter/);
  });

  it("creates one bounded retry for a recoverable dead-letter raw", () => {
    const workspaceId = "00000000-0000-0000-0000-000000000001";
    const now = new Date("2026-10-20T12:00:00.000Z");
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery(workspaceId, now, 5));

    expect(query.sql).toMatch(/LIMIT \$\d+\s*\),\s*inserted AS \(/);
    expect(query.sql).not.toMatch(/LIMIT \$\d+\s*\)\s*\),\s*inserted AS \(/);
    const recoveryAttemptParameter = Number(query.sql.match(/'recoveryAttempt', \$(\d+)::int/)?.[1]);
    expect(Number.isInteger(recoveryAttemptParameter)).toBe(true);
    expect(query.params[recoveryAttemptParameter - 1]).toBe(MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS);
    expect(query.params).toEqual([
      workspaceId,
      now.toISOString(),
      now.toISOString(),
      "invalid|not[_ ]?found|unauthorized|forbidden|bad[_ ]?request",
      5,
      MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS,
      MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS,
      now.toISOString(),
      workspaceId,
      now.toISOString(),
      now.toISOString(),
      "invalid|not[_ ]?found|unauthorized|forbidden|bad[_ ]?request",
      IDEMPOTENCY_PROBE_RECOVERY_VERSION,
      5,
      IDEMPOTENCY_PROBE_RECOVERY_VERSION,
      MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS,
      IDEMPOTENCY_PROBE_RECOVERY_VERSION,
      now.toISOString(),
    ]);
    expect(query.sql).toContain("INSERT INTO processing_jobs");
    expect(query.sql).toContain("source_job.status = 'dead_letter'");
    expect(query.sql).toContain("source_job.attempt_count >= source_job.max_attempts");
    expect(query.sql).toContain("'recoveryDisposition', 'recoverable'");
    expect(query.sql).toContain("raw_candidate_recovery:");
    expect(query.params).toContain(MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS);
  });

  it("keeps permanent dead letters terminal and supports legacy watchdog retries", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));

    expect(query.sql).toContain("dead_letter.payload #>> '{_vitalcapRecovery,disposition}' = 'recoverable'");
    expect(query.sql).toContain("source_job.last_error !~*");
    expect(query.params).toContain("invalid|not[_ ]?found|unauthorized|forbidden|bad[_ ]?request");
    expect(query.sql).toContain("source_job.last_error IS NULL AND dead_letter.last_error ~*");
    expect(query.sql).toContain("'^Max attempts exceeded via watchdog'");
  });

  it("does not duplicate active or previously recovered processing jobs", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));

    expect(query.sql).toContain("active_job.status IN ('pending', 'processing')");
    expect(query.sql).toContain("recovery_job.payload->>'recoveryAttempt' = '1'");
    expect(query.sql).toContain("diagnostic_job.payload->>'recoveryVersion' = $13");
    expect(query.sql).toContain("FOR UPDATE OF raw, source_job SKIP LOCKED");
  });

  it("keeps the normal first recovery at one attempt and leaves its attempt-1 guard intact", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));
    const normalRecoverySql = query.sql.slice(0, query.sql.indexOf("diagnostic_recoverable"));

    expect(normalRecoverySql).toContain("recovery_job.payload->>'recoveryAttempt' = '1'");
    expect(normalRecoverySql).toContain("'recoveryAttempt', $6::int");
    expect(normalRecoverySql).not.toContain("'recoveryAttempt', 2");
    expect(normalRecoverySql).not.toContain("recoveryVersion");
  });

  it("selects only current-day failed attempt-1 raws with a recoverable legacy source", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));
    const diagnosticSelection = query.sql.slice(
      query.sql.indexOf("diagnostic_recoverable AS MATERIALIZED"),
      query.sql.indexOf("diagnostic_inserted AS"),
    );

    expect(diagnosticSelection).toContain("campaign.workspace_id = $9::uuid");
    expect(diagnosticSelection).toContain("campaign.status = 'active'");
    expect(diagnosticSelection).toContain("raw.processed = false");
    expect(diagnosticSelection).toContain("raw.engine_type = 'maps_fast'");
    expect(diagnosticSelection).toContain("raw.discovered_at >= (");
    expect(diagnosticSelection).toContain("legacy_source.payload->>'recoveryAttempt' IS NULL");
    expect(diagnosticSelection).toContain("legacy_source.status = 'dead_letter'");
    expect(diagnosticSelection).toContain("legacy_source.attempt_count >= legacy_source.max_attempts");
    expect(diagnosticSelection).toContain("legacy_dead_letter.payload #>> '{_vitalcapRecovery,disposition}' IS NULL");
    expect(diagnosticSelection).toContain("legacy_source.last_error !~*");
    expect(diagnosticSelection).toContain("legacy_dead_letter.last_error ~* '^Max attempts exceeded via watchdog'");
    expect(diagnosticSelection).toContain("prior_recovery.payload->>'recoveryAttempt' = '1'");
    expect(diagnosticSelection).toContain("prior_recovery.status = 'dead_letter'");
    expect(diagnosticSelection).toContain("prior_recovery.attempt_count >= prior_recovery.max_attempts");
  });

  it("blocks active jobs, prevents another diagnostic version, and never creates attempt three", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));
    const diagnosticSelection = query.sql.slice(
      query.sql.indexOf("diagnostic_recoverable AS MATERIALIZED"),
      query.sql.indexOf("diagnostic_inserted AS"),
    );
    const diagnosticInsert = query.sql.slice(query.sql.indexOf("diagnostic_inserted AS"));

    expect(diagnosticSelection).toContain("active_job.status IN ('pending', 'processing')");
    expect(diagnosticSelection).toContain("diagnostic_job.payload->>'recoveryVersion' = $13::text");
    expect(diagnosticInsert).toContain("'recoveryVersion', $15::text");
    expect(diagnosticInsert).toContain("'recoveryAttempt', 2");
    expect(diagnosticInsert).toContain("'pending', 0, $16");
    expect(diagnosticInsert).not.toContain("'recoveryAttempt', 3");
    expect(diagnosticInsert).toContain("raw_id::text || ':' || $17::text");
    expect(query.params.filter((value) => value === IDEMPOTENCY_PROBE_RECOVERY_VERSION)).toHaveLength(3);
    expect(query.params[15]).toBe(MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS);
  });

  it("shares the five-job tick cap across normal and versioned recovery", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, MAX_RECOVERABLE_RAW_PROCESSING_JOBS_PER_TICK));
    const diagnosticSelection = query.sql.slice(
      query.sql.indexOf("diagnostic_recoverable AS MATERIALIZED"),
      query.sql.indexOf("diagnostic_inserted AS"),
    );

    expect(query.params).toContain(MAX_RECOVERABLE_RAW_PROCESSING_JOBS_PER_TICK);
    expect(diagnosticSelection).toMatch(/LIMIT GREATEST\(\$\d+ - \(SELECT COUNT\(\*\) FROM inserted\), 0\)/);
    expect(query.sql).toContain("(SELECT COUNT(*) FROM recoverable) + (SELECT COUNT(*) FROM diagnostic_recoverable)");
    expect(query.sql).toContain("(SELECT COUNT(*) FROM inserted) + (SELECT COUNT(*) FROM diagnostic_inserted)");
  });

  it("never requeues raw candidates that are already processed", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));

    expect(query.sql).toContain("raw.processed = false");
  });

  it("caps recovery to one claim attempt and the requested batch size", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));

    expect(query.sql).toContain("'recoveryAttempt'");
    const maxAttemptsParameter = Number(query.sql.match(/'pending', 0, \$(\d+)/)?.[1]);
    expect(query.params[maxAttemptsParameter - 1]).toBe(MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS);
    const limitParameter = Number(query.sql.match(/LIMIT \$(\d+)/)?.[1]);
    expect(query.params[limitParameter - 1]).toBe(5);
    expect(query.sql).toContain("raw.discovered_at >=");
  });

  it("scopes recovery to active campaigns in one workspace", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));

    expect(query.sql).toContain("campaign.workspace_id = $1::uuid");
    expect(query.sql).toContain("campaign.status = 'active'");
    expect(query.params).toContain("workspace-1");
  });

  it("only inserts processing jobs and cannot invoke providers or sending", () => {
    const query = dialect.sqlToQuery(buildRecoverableRawProcessingJobsQuery("workspace-1", claimTime, 5));

    expect(query.sql).not.toMatch(/outreach_queue|provider_runs|UPDATE raw_candidates|INSERT INTO raw_candidates/i);
    expect(query.sql).toContain("'skipMapsFastWebsiteRecovery', true");
    expect(query.sql).toContain("date_trunc('day'");
    expect(query.sql).toContain("'Europe/Madrid'");
    expect(query.sql).toContain("AS candidates_found");
    expect(query.sql).toContain("AS jobs_enqueued");
  });
});