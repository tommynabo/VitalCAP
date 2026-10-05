import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { actualPriorColdOutreachSql } from "./actual-outreach";

describe("actualPriorColdOutreachSql", () => {
  it("requires live queue evidence or a provider-confirmed event", () => {
    const query = new PgDialect().sqlToQuery(actualPriorColdOutreachSql({
      workspaceId: sql.raw("c.workspace_id"),
      accountId: sql.raw("cm.account_id"),
      contactPointId: sql.raw("cp.id"),
      normalizedEmail: sql.raw("cp.normalized_value"),
    }));

    expect(query.sql).toContain("oq.delivery_mode = 'live'");
    expect(query.sql).toContain("oq.state IN ('provider_submitted', 'sent', 'delivered', 'replied')");
    expect(query.sql).toContain("oe.state IN ('provider_submitted', 'sent', 'delivered', 'replied')");
  });
});