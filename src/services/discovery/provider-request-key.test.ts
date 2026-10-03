import { describe, expect, it } from "vitest";
import { createProviderRequestKey, nextProviderPlanningWindowAt } from "./provider-request-key";

const baseIdentity = {
  workspaceId: "workspace-1",
  campaignId: "campaign-1",
  engineType: "google_serp",
  provider: "serper",
  query: "  Farmacia   Barcelona ",
  planningWindow: "2026-10-03T11:00",
};

describe("createProviderRequestKey", () => {
  it("normalizes equivalent queries within the same planning window", () => {
    const key = createProviderRequestKey(baseIdentity);
    expect(createProviderRequestKey({ ...baseIdentity, query: "farmacia Barcelona" })).toBe(key);
  });

  it("keeps campaigns, engines, and later planning windows independent", () => {
    const key = createProviderRequestKey(baseIdentity);
    expect(createProviderRequestKey({ ...baseIdentity, campaignId: "campaign-2" })).not.toBe(key);
    expect(createProviderRequestKey({ ...baseIdentity, engineType: "linkedin_owner" })).not.toBe(key);
    expect(createProviderRequestKey({ ...baseIdentity, planningWindow: "2026-10-03T11:15" })).not.toBe(key);
  });

  it("defers retries to the next bounded planning window", () => {
    expect(nextProviderPlanningWindowAt(new Date("2026-10-03T11:07:00Z")).toISOString()).toBe("2026-10-03T11:15:00.000Z");
  });
});