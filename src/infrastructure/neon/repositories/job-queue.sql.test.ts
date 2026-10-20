import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildClaimJobsQuery, buildDeadLetterExpiredJobsQuery, buildDeferJobQuery, buildRequeueStaleLockedJobsQuery, buildRecoverableRawProcessingJobsQuery, MAX_RECOVERABLE_RAW_PROCESSING_ATTEMPTS } from "./job-queue";

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
    expect(query.sql).toContain("FOR UPDATE OF raw, source_job SKIP LOCKED");
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