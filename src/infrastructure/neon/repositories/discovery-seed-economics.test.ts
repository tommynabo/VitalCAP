import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildApifyDailyEconomicTotalsQuery, buildSeedEconomicPerformanceQuery } from "./discovery";

describe("seed economic performance query", () => {
  it("uses provider accounting and actual returned/cost values, excluding recovery probes", () => {
    const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const since = new Date("2026-10-20T12:00:00.000Z");
    const todayStart = new Date("2026-10-27T00:00:00.000Z");
    const now = new Date("2026-10-27T12:00:00.000Z");
    const query = new PgDialect().sqlToQuery(buildSeedEconomicPerformanceQuery(campaignId, "maps_fast", since, todayStart, now));

    expect(query.sql).toContain("run.metadata #>> '{ingestionAccounting,INSERTED_NEW_RAW}'");
    expect(query.sql).toContain("run.metadata #>> '{ingestionAccounting,DUPLICATE_EXISTING_RAW}'");
    expect(query.sql).toContain("outcome_attribution_complete");
    expect(query.sql).toContain("THEN COALESCE(outcomes.qualified_from_seed, 0)::int ELSE NULL END");
    expect(query.sql).toContain("run.items_returned");
    expect(query.sql).toContain("run.cost_usd");
    expect(query.sql).toContain("raw.provider_run_id = run.id");
    expect(query.sql).toContain("COALESCE(run.metadata->>'recoveryProbe', 'false') <> 'true'");
    expect(query.sql).toContain("counts.seed_count = 1");
    expect(query.params).toContain(campaignId);
    expect(query.params).toContain("maps_fast");
    expect(query.params).toContain(since.toISOString());
    expect(query.params).toContain(todayStart.toISOString());
    expect(query.params).toContain(now.toISOString());
  });

  it("reports daily actual provider cost and returned items independently of requests", () => {
    const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const since = new Date("2026-10-27T00:00:00.000Z");
    const now = new Date("2026-10-27T12:00:00.000Z");
    const query = new PgDialect().sqlToQuery(buildApifyDailyEconomicTotalsQuery(workspaceId, since, now));

    expect(query.sql).toContain("SUM(cost_usd)");
    expect(query.sql).toContain("SUM(items_returned)");
    expect(query.sql).toContain("INSERTED_NEW_RAW");
    expect(query.sql).toContain("DUPLICATE_EXISTING_RAW");
    expect(query.sql).not.toContain("items_requested *");
    expect(query.params).toContain(workspaceId);
    expect(query.params).toContain(since.toISOString());
    expect(query.params).toContain(now.toISOString());
  });
});