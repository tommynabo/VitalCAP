import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildClaimJobsQuery, buildDeadLetterExpiredJobsQuery, buildDeferJobQuery, buildRequeueStaleLockedJobsQuery } from "./job-queue";

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
});