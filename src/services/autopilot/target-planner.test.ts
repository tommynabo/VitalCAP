import { describe, expect, it } from "vitest";
import type { Campaign } from "@/domain/campaigns/types";
import { allocateMapsFastRawNeed, planningWindowKey } from "./target-planner";

function campaign(id: string, target: number, overrides: Partial<Campaign> = {}): Campaign {
  return {
    id,
    workspaceId: "workspace-1",
    offerId: "offer-1",
    name: id,
    description: "",
    status: "active",
    countryCode: "ES",
    engineType: "maps_fast",
    engineConfig: {},
    dailySoftTarget: target,
    minimumFitScore: 0,
    outreachProfileId: null,
    autopilotEnabled: true,
    desiredChannelMix: { email: 1, sms: 0 },
    timeZone: "Europe/Madrid",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("target planner", () => {
  it("allocates raw need by Maps Fast soft-target weight", () => {
    const orders = allocateMapsFastRawNeed({ workspaceId: "workspace-1", campaigns: [campaign("a", 25), campaign("b", 75)], rawNeeded: 10, reason: "behind", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid" });
    expect(orders.map((order) => order.desiredRawCount)).toEqual([2, 8]);
  });

  it("excludes paused campaigns and uses one idempotent planning window", () => {
    const orders = allocateMapsFastRawNeed({ workspaceId: "workspace-1", campaigns: [campaign("a", 50), campaign("paused", 50, { status: "paused" })], rawNeeded: 10, reason: "behind", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid" });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.desiredRawCount).toBe(10);
    expect(orders[0]?.idempotencyKey).toContain("autopilot:workspace-1:a:");
    expect(planningWindowKey(new Date("2025-01-01T13:14:00Z"), "Europe/Madrid")).toBe(planningWindowKey(new Date("2025-01-01T13:14:59Z"), "Europe/Madrid"));
  });
});