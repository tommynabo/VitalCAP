import { describe, expect, it } from "vitest";
import { createCampaignSchema } from "./create";
import { updateCampaignSchema } from "./update";

describe("campaign mutation schemas", () => {
  it("defaults dashboard-created campaigns to active with Autopilot enabled", () => {
    const campaign = createCampaignSchema.parse({
      name: "Spain pharmacies",
      engineType: "maps_fast",
      dailySoftTarget: 50,
    });

    expect(campaign.status).toBe("active");
    expect(campaign.autopilotEnabled).toBe(true);
  });

  it("accepts each persisted campaign control", () => {
    expect(updateCampaignSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      status: "paused",
      autopilotEnabled: false,
      dailySoftTarget: 120,
    })).toMatchObject({ status: "paused", autopilotEnabled: false, dailySoftTarget: 120 });
  });

  it("rejects empty and invalid campaign updates", () => {
    expect(() => updateCampaignSchema.parse({ id: "00000000-0000-4000-8000-000000000001" })).toThrow();
    expect(() => updateCampaignSchema.parse({ id: "00000000-0000-4000-8000-000000000001", status: "running" })).toThrow();
  });
});
