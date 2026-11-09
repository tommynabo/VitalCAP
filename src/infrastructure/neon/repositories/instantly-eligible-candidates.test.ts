import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildInstantEligibleCandidatesQuery } from "./instantly-eligible-candidates";

describe("buildInstantEligibleCandidatesQuery campaign routing", () => {
  it("scopes candidate reads to the source campaign and provider target", () => {
    const query = new PgDialect().sqlToQuery(buildInstantEligibleCandidatesQuery({
      providerCampaignId: "instantly-yoga",
      campaignId: "internal-yoga",
      backfillAll: true,
      forEnqueue: true,
    }));

    expect(query.sql).toContain("cm.campaign_id = $5::uuid");
    expect(query.sql).toContain("ili.provider_campaign_id = $6");
    expect(query.params).toContain("internal-yoga");
    expect(query.params).toContain("instantly-yoga");
    expect(query.sql).toContain("cp.verification_status = 'valid'");
    expect(query.sql).toContain("suppression_entries");
  });

  it("preserves the cross-campaign legacy query when no source campaign is specified", () => {
    const query = new PgDialect().sqlToQuery(buildInstantEligibleCandidatesQuery({
      providerCampaignId: "legacy-target",
      backfillAll: true,
    }));

    expect(query.sql).not.toContain("cm.campaign_id =");
  });

  it("allows Draft only through the explicit scoped option and keeps autopilot off", () => {
    const activeOnly = new PgDialect().sqlToQuery(buildInstantEligibleCandidatesQuery({
      providerCampaignId: "instantly-yoga",
      campaignId: "internal-yoga",
    }));
    const scopedDraft = new PgDialect().sqlToQuery(buildInstantEligibleCandidatesQuery({
      providerCampaignId: "instantly-yoga",
      campaignId: "internal-yoga",
      workspaceId: "workspace-yoga",
      contactPointIds: ["contact-point-yoga"],
      allowScopedDraftCampaign: true,
    }));

    expect(activeOnly.sql).toContain("WHERE c.status = 'active'");
    expect(activeOnly.sql).not.toContain("c.status = 'draft'");
    expect(scopedDraft.sql).toContain("WHERE c.status = 'draft' AND c.autopilot_enabled = false");
    expect(scopedDraft.sql).not.toContain("c.status = 'active'");
    expect(scopedDraft.sql).toContain("c.workspace_id =");
    expect(scopedDraft.sql).toContain("cm.campaign_id =");
    expect(scopedDraft.sql).toContain("cp.id IN");
    expect(scopedDraft.params).toContain("workspace-yoga");
    expect(scopedDraft.params).toContain("internal-yoga");
    expect(scopedDraft.params).toContain("contact-point-yoga");
  });
});