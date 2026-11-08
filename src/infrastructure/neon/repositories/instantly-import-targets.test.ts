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

const nicheTargets = [
  { niche: "yoga_pilates", campaignId: "yoga-campaign", target: "7ba53c91-6c8f-4b8a-b260-72eb48f62d07" },
  { niche: "spas_wellness", campaignId: "wellness-campaign", target: "20013626-0dc5-4bb4-a2bf-c4b99450cdb6" },
  { niche: "premium_fitness", campaignId: "premium-campaign", target: "5f42f2cf-5ebc-412e-814f-5eca8b1fea71" },
  { niche: "personal_training", campaignId: "personal-campaign", target: "2413f6f5-2e21-46c2-addc-9b8c2ff90a34" },
] as const;

function mappedNicheCampaign(
  niche: string,
  campaignId: string,
  target: string,
  overrides: Partial<Parameters<typeof resolveInstantlyImportTargets>[0][number]> = {},
) {
  return campaignRow({
    campaign_id: campaignId,
    engine_config: { niche, instantlyCampaignId: "ignored-engine-config-target" },
    mapping_campaign_id: campaignId,
    mapping_enabled: true,
    mapped_provider_campaign_id: target,
    ...overrides,
  });
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
    const result = resolveInstantlyImportTargets(nicheTargets.map(({ niche, campaignId, target }) =>
      mappedNicheCampaign(niche, campaignId, target)), "legacy-target");

    expect(result.targets.map(({ campaignId, providerCampaignId }) => [campaignId, providerCampaignId]))
      .toEqual(nicheTargets.map(({ campaignId, target }) => [campaignId, target]));
    expect(result.blockedCampaignIds).toEqual([]);
  });

  it.each(nicheTargets.flatMap((source) => nicheTargets
    .filter((target) => target.niche !== source.niche)
    .map((target) => ({ source, target }))))(
    "blocks $source.niche mapped to $target.niche target",
    ({ source, target }) => {
      const result = resolveInstantlyImportTargets([
        mappedNicheCampaign(source.niche, source.campaignId, target.target),
      ], "legacy-target");

      expect(result.targets).toEqual([]);
      expect(result.blockedCampaignIds).toEqual([source.campaignId]);
    },
  );

  it("blocks a niche campaign without an explicit mapping even when engine config has a target", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow({
        campaign_id: "yoga-campaign",
        engine_config: { niche: "yoga_pilates", instantlyCampaignId: nicheTargets[0].target },
      }),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
  });

  it("blocks a niche route that shares an external target with another campaign", () => {
    const result = resolveInstantlyImportTargets([
      mappedNicheCampaign("yoga_pilates", "yoga-campaign", "shared-target"),
      mappedNicheCampaign("spas_wellness", "wellness-campaign", "shared-target"),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign", "wellness-campaign"]);
  });

  it("blocks a colliding niche route without pausing the existing legacy target", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow(),
      mappedNicheCampaign("yoga_pilates", "yoga-campaign", nicheTargets[0].target),
    ], nicheTargets[0].target);

    expect(result.targets).toEqual([expect.objectContaining({ campaignId: "campaign-1", legacyFallback: true })]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
  });

  it("blocks a known niche target when its campaign has no niche", () => {
    const result = resolveInstantlyImportTargets([
      campaignRow({
        campaign_id: "yoga-campaign",
        mapping_campaign_id: "yoga-campaign",
        mapping_enabled: true,
        mapped_provider_campaign_id: nicheTargets[0].target,
      }),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
  });

  it("blocks duplicate rows for the same niche mapping as ambiguous", () => {
    const yoga = mappedNicheCampaign("yoga_pilates", "yoga-campaign", nicheTargets[0].target);
    const result = resolveInstantlyImportTargets([yoga, yoga], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
    expect(result.blockedCampaignReasons).toEqual([{ campaignId: "yoga-campaign", reason: "ambiguous_mapping_rows" }]);
  });

  it("blocks every target when duplicate rows disagree, including an otherwise valid mapping", () => {
    const correct = mappedNicheCampaign("yoga_pilates", "yoga-campaign", nicheTargets[0].target);
    const incorrect = mappedNicheCampaign("yoga_pilates", "yoga-campaign", nicheTargets[1].target);
    const result = resolveInstantlyImportTargets([correct, incorrect], "legacy-target");

    expect(result.targets).toEqual([]);
    expect(result.blockedCampaignIds).toEqual(["yoga-campaign"]);
    expect(result.blockedCampaignReasons).toEqual([{ campaignId: "yoga-campaign", reason: "ambiguous_mapping_rows" }]);
  });

  it("blocks a malformed niche mapping owned by another campaign", () => {
    const result = resolveInstantlyImportTargets([
      mappedNicheCampaign("yoga_pilates", "yoga-campaign", nicheTargets[0].target, {
        mapping_campaign_id: "different-campaign",
      }),
    ], "legacy-target");

    expect(result.targets).toEqual([]);
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