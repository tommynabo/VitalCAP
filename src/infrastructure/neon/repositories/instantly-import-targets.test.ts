import { describe, expect, it } from "vitest";
import { resolveInstantlyImportTargets } from "./instantly-import-targets";

function campaignRow(overrides: Partial<Parameters<typeof resolveInstantlyImportTargets>[0][number]> = {}) {
  return {
    campaign_id: "campaign-1",
    workspace_id: "workspace-1",
    engine_config: {},
    mapping_campaign_id: null,
    mapping_enabled: null,
    mapped_provider_campaign_id: null,
    ...overrides,
  };
}

describe("resolveInstantlyImportTargets", () => {
  it("keeps the legacy environment target for unmapped campaigns without a niche", () => {
    expect(resolveInstantlyImportTargets([campaignRow()], "legacy-target")).toMatchObject({
      targets: [{ campaignId: "campaign-1", providerCampaignId: "legacy-target", legacyFallback: true }],
      blockedCampaignIds: [],
    });
  });

  it("keeps multiple legacy campaigns on the shared environment target", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow({ campaign_id: "legacy-one" }),
      campaignRow({ campaign_id: "legacy-two" }),
    ], "legacy-target");

    expect(result.targets.map(({ campaignId, providerCampaignId }) => [campaignId, providerCampaignId]))
      .toEqual([["legacy-one", "legacy-target"], ["legacy-two", "legacy-target"]]);
    expect(result.blockedCampaignIds).toEqual([]);
  });

  it("routes each niche only to its explicit enabled mapping", () => {
    const yoga = campaignRow({
      campaign_id: "yoga-campaign",
      engine_config: { niche: "yoga_pilates" },
      mapping_campaign_id: "yoga-campaign",
      mapping_enabled: true,
      mapped_provider_campaign_id: "instantly-yoga",
    });
    const wellness = campaignRow({
      campaign_id: "wellness-campaign",
      engine_config: { niche: "spas_wellness" },
      mapping_campaign_id: "wellness-campaign",
      mapping_enabled: true,
      mapped_provider_campaign_id: "instantly-wellness",
    });

    expect(resolveInstantlyImportTargets([yoga, wellness], "legacy-target").targets.map(({ campaignId, providerCampaignId }) => [campaignId, providerCampaignId]))
      .toEqual([["yoga-campaign", "instantly-yoga"], ["wellness-campaign", "instantly-wellness"]]);
  });

  it("blocks niche campaigns without a specific target instead of falling back globally", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow({ campaign_id: "yoga-campaign", engine_config: { niche: "yoga_pilates" } }),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
  });

  it("blocks a niche route that shares an external target with another campaign", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow({ engine_config: { niche: "yoga_pilates", instantlyCampaignId: "shared-target" } }),
      campaignRow({ campaign_id: "wellness-campaign", engine_config: { niche: "spas_wellness", instantlyCampaignId: "shared-target" } }),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["campaign-1", "wellness-campaign"]);
  });

  it("blocks a colliding niche route without pausing the existing legacy target", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow(),
      campaignRow({
        campaign_id: "yoga-campaign",
        engine_config: { niche: "yoga_pilates", instantlyCampaignId: "legacy-target" },
      }),
    ], "legacy-target");

    expect(result.targets).toEqual([expect.objectContaining({ campaignId: "campaign-1", legacyFallback: true })]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
  });

  it("does not route campaigns with explicitly disabled mappings", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow({
        engine_config: { niche: "yoga_pilates", instantlyCampaignId: "ignored-target" },
        mapping_campaign_id: "campaign-1",
        mapping_enabled: false,
        mapped_provider_campaign_id: "disabled-target",
      }),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["campaign-1"]);
  });
});