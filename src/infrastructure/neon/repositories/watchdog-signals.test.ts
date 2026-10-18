import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildRecoveryProbeDiscoveryJobsQuery } from "./watchdog-signals";

const dialect = new PgDialect();

describe("recovery probe discovery job diagnostics SQL", () => {
  it("reads only workspace-scoped recovery metadata, newest first, with a ten-row limit", () => {
    const query = dialect.sqlToQuery(buildRecoveryProbeDiscoveryJobsQuery("workspace-1"));
    const selectClause = query.sql.slice(0, query.sql.indexOf("FROM discovery_jobs"));

    expect(query.sql).toContain("INNER JOIN campaigns c ON c.id = dj.campaign_id");
    expect(query.sql).toMatch(/WHERE c\.workspace_id = \$\d+::uuid/);
    expect(query.sql).toContain("dj.payload->>'origin' = 'recovery_probe'");
    expect(query.sql).toContain("ORDER BY dj.created_at DESC, dj.id DESC");
    expect(query.sql).toContain("LIMIT 10");
    expect(query.sql).toContain("lock_expires_at");
    expect(query.sql).toContain("provider_deferred");
    expect(query.sql).toContain("last_error_present");
    expect(query.sql).toContain("dj.last_error AS last_error");
    expect(query.sql).toContain("AS sensitive_terms");
    expect(query.sql).toContain("ss.query AS term");
    expect(query.sql).toContain("ss.geography AS term");
    expect(selectClause).not.toContain("dj.payload,");
    expect(selectClause).not.toContain("dj.payload AS payload");
    expect(query.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(query.params).toContain("workspace-1");
  });
});