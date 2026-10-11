import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildApifyPollingDuePredicate, buildReserveApifyProviderRunQuery } from "./provider-runs";

const dialect = new PgDialect();

describe("Apify provider run reservation SQL", () => {
  it("retains raw, spend, manual reconciliation, and idempotency guards for recovery probes", () => {
    const query = dialect.sqlToQuery(buildReserveApifyProviderRunQuery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      campaignId: "00000000-0000-0000-0000-000000000002",
      operation: "maps_search",
      requestKey: "apify:stable-key",
      seedId: "00000000-0000-0000-0000-000000000003",
      itemsRequested: 10,
      recoveryProbe: true,
    }, 1500, 15, new Date("2026-10-11T00:00:00.000Z"), 0.05));

    expect(query.sql).toContain("status = 'manual_reconciliation_required'");
    expect(query.sql).toContain("safety.unreconciled_count = 0");
    expect(query.sql).toContain("safety.requested_today +");
    expect(query.sql).toContain("<=");
    expect(query.sql).toContain("safety.cost_today +");
    expect(query.sql).toContain("safety.recovery_probe_count = 0");
    expect(query.sql).toContain("ON CONFLICT (request_key) DO NOTHING");
    expect(query.params).toContain(1500);
    expect(query.params).toContain(15);
  });

  it("does not poll an existing provider run before its typed retry cooldown is due", () => {
    const query = dialect.sqlToQuery(buildApifyPollingDuePredicate(new Date("2026-10-11T18:00:00.000Z")));

    expect(query.sql).toContain("metadata->>'pollRetryAt' IS NULL");
    expect(query.sql).toContain("<=");
    expect(query.params).toContain("2026-10-11T18:00:00.000Z");
  });
});