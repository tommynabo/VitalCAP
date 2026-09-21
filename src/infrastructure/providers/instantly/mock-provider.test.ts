import { describe, expect, it } from "vitest";
import { MockInstantlyEmailDeliveryProvider } from "./mock-provider";

describe("MockInstantlyEmailDeliveryProvider", () => {
  it("adds a lead and returns a deterministic providerLeadId", async () => {
    const provider = new MockInstantlyEmailDeliveryProvider();
    const { result } = await provider.addLead({
      providerCampaignId: "camp_abc",
      email: "owner@example.es",
      customVariables: {},
      skipIfExisting: true,
    });
    expect(result.status).toBe("added");
    expect(result.providerLeadId).toMatch(/^instantly_lead_/);
  });

  it("reports skipped_existing on a second add with skipIfExisting", async () => {
    const provider = new MockInstantlyEmailDeliveryProvider();
    const input = { providerCampaignId: "camp_abc", email: "owner@example.es", customVariables: {}, skipIfExisting: true };
    await provider.addLead(input);
    const { result } = await provider.addLead(input);
    expect(result.status).toBe("skipped_existing");
  });

  it("syncStatus returns a deterministic status event with usage stats", async () => {
    const provider = new MockInstantlyEmailDeliveryProvider();
    const { events, usage } = await provider.syncStatus("camp_abc", new Date("2025-01-01T00:00:00Z"));
    expect(events).toHaveLength(1);
    expect(usage.calls).toBe(1);
  });
});
