import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildDeadLetterExpiredJobsQuery, buildRequeueStaleLockedJobsQuery } from "./job-queue";

const dialect = new PgDialect();

describe("job queue SQL builders", () => {
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