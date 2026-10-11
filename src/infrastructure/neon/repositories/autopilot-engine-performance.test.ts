import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildAutopilotEnginePerformanceQuery } from "./autopilot-engine-performance";

describe("autopilot engine performance query", () => {
  it("uses confirmed imports for the configured target and excludes ambiguous source attribution", () => {
    const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const targetCampaignId = "target-instantly-campaign";
    const now = new Date("2026-10-11T12:00:00.000Z");
    const query = new PgDialect().sqlToQuery(buildAutopilotEnginePerformanceQuery(workspaceId, targetCampaignId, now));

    expect(query.sql).toMatch(/ili\.provider_campaign_id = \$\d+/);
    expect(query.sql).toContain("ili.status = 'instantly_added'");
    expect(query.sql).toContain("ili.provider_lead_id IS NOT NULL");
    expect(query.sql).toContain("cp.verification_provider = 'millionverifier'");
    expect(query.sql).toContain("cd.decision = 'allowed' AND cd.superseded_at IS NULL");
    expect(query.sql).toContain("AND provider IN ('apify', 'serper')");
    expect(query.sql).toContain("ili.source_campaign_id = source.campaign_id");
    expect(query.sql).toContain("rcc.campaign_count = 1");
    expect(query.sql).toContain("competing.source_type <> rr.engine_type");
    expect(query.sql).toContain("src.source_type IN ('maps_fast', 'maps_deep', 'google_serp', 'linkedin_owner')");
    expect(query.sql).toContain("cp.verification_provider = 'millionverifier'");
    expect(query.sql).toContain("FROM provider_runs");
    expect(query.params).toContain(workspaceId);
    expect(query.params).toContain(targetCampaignId);
    expect(query.params).toContain("2026-10-04T12:00:00.000Z");
  });
});