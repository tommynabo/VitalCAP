import { describe, expect, it } from "vitest";
import type { Campaign } from "@/domain/campaigns/types";
import { allocateEngineWork, allocateMapsFastRawNeed, MAX_RAW_PER_PLANNING_WINDOW, planningWindowKey, rerouteEngineOrders } from "./target-planner";

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

  it("supports a 250-qualified target without a legacy 100-raw planning ceiling", () => {
    const orders = allocateMapsFastRawNeed({ workspaceId: "workspace-1", campaigns: [campaign("a", 250)], rawNeeded: 834, reason: "30% historical yield", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid" });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.desiredRawCount).toBe(MAX_RAW_PER_PLANNING_WINDOW);
    expect(orders[0]?.desiredRawCount).toBeGreaterThan(100);
  });

  it("allocates the one global deficit across configured healthy engines by observed yield", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("maps", 100), campaign("serp", 100, { engineType: "google_serp" }), campaign("owner", 100, { engineType: "linkedin_owner" })],
      capabilities: [
        { engineType: "maps_fast", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: null, reason: null },
        { engineType: "google_serp", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: null, reason: null },
        { engineType: "linkedin_owner", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: null, reason: null },
      ],
      performances: [
        { campaignId: "maps", yield: 0.35, queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "serp", yield: 0.18, queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "owner", yield: 0.1, queueDepth: 0, seedExhaustion: 0 },
      ],
      rawNeeded: 100,
      reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"),
      timeZone: "Europe/Madrid",
    });
    expect(orders.reduce((sum, order) => sum + order.desiredRawCount, 0)).toBe(100);
    expect(orders.find((order) => order.engineType === "maps_fast")?.desiredRawCount).toBeGreaterThan(orders.find((order) => order.engineType === "google_serp")?.desiredRawCount ?? 0);
    expect(orders.map((order) => order.engineType)).toEqual(expect.arrayContaining(["maps_fast", "google_serp", "linkedin_owner"]));
  });

  it("does not multiply the global target or schedule paused, draft, or unavailable engines", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("active", 250, { engineType: "maps_deep" }), campaign("paused", 250, { engineType: "google_serp", status: "paused" }), campaign("draft", 250, { engineType: "linkedin_owner", status: "draft" })],
      capabilities: [
        { engineType: "maps_deep", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: null, reason: null },
        { engineType: "google_serp", available: false, providerConfigured: false, providerHealthy: false, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: "provider_not_configured", reason: "provider_not_configured" },
      ],
      rawNeeded: 500,
      reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"),
      timeZone: "Europe/Madrid",
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ campaignId: "active", engineType: "maps_deep", desiredRawCount: MAX_RAW_PER_PLANNING_WINDOW });
  });

  it("routes underperforming Maps Fast allocation to SERP without increasing the global order", () => {
    const campaigns = [
      campaign("maps", 100),
      campaign("serp", 100, { engineType: "google_serp" }),
      campaign("owner", 100, { engineType: "linkedin_owner" }),
    ];
    const capabilities = ["maps_fast", "google_serp", "linkedin_owner"].map((engineType) => ({
      engineType: engineType as Campaign["engineType"],
      available: true,
      providerConfigured: true,
      providerHealthy: true,
      providerUntested: false,
      costAllowed: true,
      campaignCount: 1,
      reasonUnavailable: null,
      reason: null,
    }));
    const performances = [
      { campaignId: "maps", yield: 0.02, queueDepth: 0, seedExhaustion: 0 },
      { campaignId: "serp", yield: 0.3, queueDepth: 0, seedExhaustion: 0 },
      { campaignId: "owner", yield: 0.1, queueDepth: 0, seedExhaustion: 0 },
    ];
    const input = {
      workspaceId: "workspace-1",
      campaigns,
      capabilities,
      performances,
      rawNeeded: 100,
      reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"),
      timeZone: "Europe/Madrid",
    };
    const original = allocateEngineWork(input);
    const rerouted = rerouteEngineOrders({ ...input, orders: original, fromEngine: "maps_fast", reason: "Maps Fast underperformed" });

    expect(rerouted.some((order) => order.engineType === "maps_fast")).toBe(false);
    expect(rerouted.find((order) => order.engineType === "google_serp")?.desiredRawCount)
      .toBeGreaterThan(original.find((order) => order.engineType === "google_serp")?.desiredRawCount ?? 0);
    expect(rerouted.reduce((total, order) => total + order.desiredRawCount, 0)).toBe(100);
    expect(rerouted.some((order) => order.origin === "hybrid_fill")).toBe(true);
  });
});
