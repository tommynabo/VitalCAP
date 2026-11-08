import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildAutopilotEnginePerformanceQuery } from "./autopilot-engine-performance";

describe("autopilot engine performance query", () => {
  it("attributes confirmed imports to their internal source campaign and excludes ambiguous sources", () => {
    const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const now = new Date("2026-10-11T12:00:00.000Z");
    const query = new PgDialect().sqlToQuery(buildAutopilotEnginePerformanceQuery(workspaceId, now));

    expect(query.sql).toContain("ili.status = 'instantly_added'");
    expect(query.sql).toContain("ili.provider_lead_id IS NOT NULL");
    expect(query.sql).toContain("cp.verification_provider = 'millionverifier'");
    expect(query.sql).toContain("cd.decision = 'allowed' AND cd.superseded_at IS NULL");
    expect(query.sql).toContain("AND run.provider IN ('apify', 'serper')");
    expect(query.sql).toContain("ili.source_campaign_id = source.campaign_id");
    expect(query.sql).toContain("rcc.campaign_count = 1");
    expect(query.sql).toContain("rcc.engine_count = 1");
    expect(query.sql).toContain("competing.source_type <> rr.engine_type");
    expect(query.sql).toContain("src.source_type IN ('maps_fast', 'maps_deep', 'google_serp', 'linkedin_owner')");
    expect(query.sql).toContain("cp.verification_provider = 'millionverifier'");
    expect(query.sql).toContain("FROM provider_runs");
    expect(query.params).toContain(workspaceId);
    expect(query.sql).toContain("ili.source_campaign_id = source.campaign_id");
    expect(query.params).toContain("2026-10-04T12:00:00.000Z");
  });

  it("keeps provider costs and discovery outcomes separated by campaign engine", () => {
    const query = new PgDialect().sqlToQuery(buildAutopilotEnginePerformanceQuery(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      new Date("2026-10-11T12:00:00.000Z"),
    ));

    expect(query.sql).toContain("COALESCE(rr.engine_type, c.engine_type) AS engine_type");
    expect(query.sql).toContain("JOIN search_seeds seed ON seed.id = run.seed_id AND seed.campaign_id = run.campaign_id");
    expect(query.sql).toContain("GROUP BY run.campaign_id, seed.engine_type");
    expect(query.sql).toContain("imports.engine_type = metrics.engine_type");
    expect(query.sql).toContain("costs.engine_type = metrics.engine_type");
  });
});