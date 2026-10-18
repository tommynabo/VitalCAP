import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildDeadLetterAggregateQuery } from "./production-capacity-diagnostics-sql";

const dialect = new PgDialect();

describe("dead-letter diagnostics SQL", () => {
  it("groups workspace dead letters by queue, engine, normalized class, and age", () => {
    const query = dialect.sqlToQuery(buildDeadLetterAggregateQuery("workspace-id", new Date("2026-10-18T12:00:00.000Z")));

    expect(query.sql).toContain("GROUP BY queue_type, engine, failure_class, age_bucket");
    expect(query.sql).toContain("'lt_24h'");
    expect(query.sql).toContain("'1_3d'");
    expect(query.sql).toContain("'3_7d'");
    expect(query.sql).toContain("'gt_7d'");
    expect(query.sql).toContain("'reservation_parameter_typing'");
    expect(query.sql).toContain("'provider_authentication'");
    expect(query.sql).toContain("FROM verification_jobs verification_job");
    expect(query.sql).toContain("FROM intelligence_jobs intelligence_job");
    expect(query.params).toContain("workspace-id");
    expect(query.params).toContain("2026-10-18T12:00:00.000Z");
  });

  it("returns only aggregate grouping fields and never projects error or payload data", () => {
    const query = dialect.sqlToQuery(buildDeadLetterAggregateQuery("workspace-id", new Date("2026-10-18T12:00:00.000Z")));
    const projection = query.sql.slice(query.sql.lastIndexOf("SELECT queue_type"));

    expect(projection).toMatch(/^SELECT queue_type, engine, failure_class, age_bucket, COUNT\(\*\)::int AS count/);
    expect(projection).not.toMatch(/last_error|payload|source_url|normalized_value/i);
  });
});