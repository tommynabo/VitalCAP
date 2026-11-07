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
});