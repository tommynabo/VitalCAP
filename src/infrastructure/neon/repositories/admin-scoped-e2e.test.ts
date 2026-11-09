import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS } from "@/services/autopilot/multi-niche-rollout";
import { buildAdminScopedCandidateListQuery } from "./admin-scoped-e2e";

const dialect = new PgDialect();

describe("buildAdminScopedCandidateListQuery", () => {
  it("scopes candidate diagnostics to the workspace and four rollout campaigns", () => {
    const query = dialect.sqlToQuery(buildAdminScopedCandidateListQuery({
      workspaceId: "workspace-1",
      limit: 20,
    }));

    expect(query.sql).toContain("campaign.workspace_id =");
    expect(query.sql).toContain("raw.campaign_id IN (");
    expect(query.params).toContain("workspace-1");
    for (const campaignId of MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS) {
      expect(query.params).toContain(campaignId);
    }
    expect(query.sql).not.toContain("normalized_value");
  });

  it("applies optional exact campaign/stage filters and caps the result at 20", () => {
    const query = dialect.sqlToQuery(buildAdminScopedCandidateListQuery({
      workspaceId: "workspace-1",
      campaignId: MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS[0],
      stage: "ready",
      limit: 200,
    }));

    expect(query.sql).toContain("raw.campaign_id =");
    expect(query.sql).toContain("membership.stage =");
    expect(query.params).toContain("ready");
    expect(query.sql).toMatch(/LIMIT \$\d+\s*$/);
    expect(query.params.at(-1)).toBe(20);
  });
});