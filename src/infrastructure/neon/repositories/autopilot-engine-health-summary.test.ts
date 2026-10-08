import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildEngineHealthUsageSummaryQuery } from "./autopilot";
import { computeEngineHealthSummary } from "@/services/discovery/provider-health";

describe("dashboard engine-health summary", () => {
  it("returns the same badge count for representative old engine-health states", () => {
    const summary = computeEngineHealthSummary({
      mapsConfigured: true,
      serpConfigured: true,
      mapsUsage: { calls: 5, errors: 2 },
      serpUsage: { calls: 5, errors: 3 },
    });

    expect(summary).toEqual({ unhealthyCount: 5, totalCount: 5 });
  });

  it("handles an empty workspace as untested when providers are configured", () => {
    const summary = computeEngineHealthSummary({
      mapsConfigured: true,
      serpConfigured: true,
      mapsUsage: { calls: 0, errors: 0 },
      serpUsage: { calls: 0, errors: 0 },
    });

    expect(summary).toEqual({ unhealthyCount: 0, totalCount: 5 });
  });

  it("counts healthy and unhealthy engine combinations using existing thresholds", () => {
    const healthy = computeEngineHealthSummary({
      mapsConfigured: true,
      serpConfigured: true,
      mapsUsage: { calls: 5, errors: 0 },
      serpUsage: { calls: 5, errors: 0 },
    });
    const unhealthy = computeEngineHealthSummary({
      mapsConfigured: true,
      serpConfigured: true,
      mapsUsage: { calls: 5, errors: 1 },
      serpUsage: { calls: 5, errors: 0 },
    });

    expect(healthy.totalCount - healthy.unhealthyCount).toBe(5);
    expect(unhealthy).toEqual({ unhealthyCount: 2, totalCount: 5 });
  });

  it("aggregates only provider usage within the requested workspace", () => {
    const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const since = new Date("2026-10-08T00:00:00.000Z");
    const query = new PgDialect().sqlToQuery(buildEngineHealthUsageSummaryQuery(workspaceId, since));

    expect(query.sql).toContain("FROM provider_runs");
    expect(query.sql).toContain("workspace_id = $1::uuid");
    expect(query.sql).toContain("GROUP BY provider");
    expect(query.sql).toContain("count(*) FILTER");
    expect(query.sql).not.toMatch(/JOIN|campaigns|accounts|prospect_analyses|SELECT \*/i);
    expect(query.params).toEqual([workspaceId, since]);
  });
});