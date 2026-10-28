import { describe, expect, it } from "vitest";
import type { Campaign } from "@/domain/campaigns/types";
import { buildEngineCapabilities } from "./engine-capability";
import { getApifyAllocationHealth, resolveApifyDiscoveryWorkMode, evaluateApifyRecovery, evaluateProviderHealth, type ApifyRecoveryRun } from "@/services/discovery/provider-health";
import { allocateEngineWork, allocateMapsFastRawNeed, MAX_RAW_PER_PLANNING_WINDOW, planApifyRecoveryProbe, planningWindowKey, rerouteEngineOrders, resolvePlanningWindow } from "./target-planner";

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

  it("advances retried work to the current window without extending a stale idempotency key", () => {
    const now = new Date("2025-01-01T13:30:00Z");
    expect(resolvePlanningWindow("2025-01-01T14:45", now, "Europe/Madrid")).toBe("2025-01-01T14:45");
    expect(resolvePlanningWindow("2025-01-01T13:00", now, "Europe/Madrid")).toBe("2025-01-01T14:30");
  });

  it("supports a 250-qualified target without a legacy 100-raw planning ceiling", () => {
    const orders = allocateMapsFastRawNeed({ workspaceId: "workspace-1", campaigns: [campaign("a", 250)], rawNeeded: 834, reason: "30% historical yield", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid" });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.desiredRawCount).toBe(MAX_RAW_PER_PLANNING_WINDOW);
    expect(orders[0]?.desiredRawCount).toBeGreaterThan(100);
    expect(MAX_RAW_PER_PLANNING_WINDOW).toBe(500);
  });

  it("keeps 250 as one workspace-global raw deficit across engines", () => {
    const campaigns = [campaign("maps", 250), campaign("serp", 250, { engineType: "google_serp" }), campaign("owner", 250, { engineType: "linkedin_owner" })];
    const capabilities = campaigns.map((item) => ({
      engineType: item.engineType,
      available: true,
      providerConfigured: true,
      providerHealthy: true,
      providerUntested: false,
      costAllowed: true,
      campaignCount: 1,
      reasonUnavailable: null,
      reason: null,
    }));
    const orders = allocateEngineWork({
      workspaceId: "workspace-1", campaigns, capabilities, rawNeeded: 250, reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid",
    });

    expect(orders.reduce((total, order) => total + order.desiredRawCount, 0)).toBe(250);
  });

  it("allocates proportionally to observed confirmed-import/raw yield", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("high", 100), campaign("low", 100, { engineType: "google_serp" })],
      capabilities: ["maps_fast", "google_serp"].map((engineType) => ({
        engineType: engineType as Campaign["engineType"], available: true, providerConfigured: true,
        providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1,
        reasonUnavailable: null, reason: null,
      })),
      performances: [
        { campaignId: "high", yield: 0.2, yieldTier: "confirmed_instantly", queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "low", yield: 0.05, yieldTier: "confirmed_instantly", queueDepth: 0, seedExhaustion: 0 },
      ],
      rawNeeded: 100, reason: "behind pace", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid",
    });

    expect(orders.find((order) => order.campaignId === "high")?.desiredRawCount).toBeGreaterThan(orders.find((order) => order.campaignId === "low")?.desiredRawCount ?? 0);
  });

  it("weights confirmed-import cost only after the minimum import sample", () => {
    const campaigns = [campaign("cheaper", 100), campaign("costlier", 100, { engineType: "google_serp" })];
    const capabilities = ["maps_fast", "google_serp"].map((engineType) => ({
      engineType: engineType as Campaign["engineType"], available: true, providerConfigured: true,
      providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1,
      reasonUnavailable: null, reason: null,
    }));
    const input = {
      workspaceId: "workspace-1", campaigns, capabilities, rawNeeded: 100, reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid",
    };
    const confirmedCostOrders = allocateEngineWork({
      ...input,
      performances: [
        { campaignId: "cheaper", yield: 0.1, confirmedImportCount: 5, costPerConfirmedImportUsd: 0.1, queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "costlier", yield: 0.1, confirmedImportCount: 5, costPerConfirmedImportUsd: 0.2, queueDepth: 0, seedExhaustion: 0 },
      ],
    });
    const smallSampleOrders = allocateEngineWork({
      ...input,
      performances: [
        { campaignId: "cheaper", yield: 0.1, confirmedImportCount: 4, costPerConfirmedImportUsd: 0.1, queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "costlier", yield: 0.1, confirmedImportCount: 4, costPerConfirmedImportUsd: 0.2, queueDepth: 0, seedExhaustion: 0 },
      ],
    });

    expect(confirmedCostOrders.find((order) => order.campaignId === "cheaper")?.desiredRawCount)
      .toBeGreaterThan(confirmedCostOrders.find((order) => order.campaignId === "costlier")?.desiredRawCount ?? 0);
    expect(smallSampleOrders.map((order) => order.desiredRawCount)).toEqual([50, 50]);
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

  it("keeps LinkedIn available as small exploration while prioritizing Google SERP", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("serp", 100, { engineType: "google_serp" }), campaign("owner", 100, { engineType: "linkedin_owner" })],
      capabilities: ["google_serp", "linkedin_owner"].map((engineType) => ({
        engineType: engineType as Campaign["engineType"], available: true, providerConfigured: true,
        providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1,
        reasonUnavailable: null, reason: null,
      })),
      performances: [
        { campaignId: "serp", yield: 0.1, queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "owner", yield: 0.1, confirmedImportCount: 0, queueDepth: 0, seedExhaustion: 0 },
      ],
      rawNeeded: 100,
      reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"),
      timeZone: "Europe/Madrid",
    });

    const google = orders.find((order) => order.engineType === "google_serp")?.desiredRawCount ?? 0;
    const linkedin = orders.find((order) => order.engineType === "linkedin_owner")?.desiredRawCount ?? 0;
    expect(google).toBeGreaterThan(linkedin);
    expect(linkedin).toBeGreaterThan(0);
  });

  it("does not multiply the global target or schedule paused, draft, or unavailable engines", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("active", 250, { engineType: "maps_deep" }), campaign("paused", 250, { engineType: "google_serp", status: "paused" }), campaign("draft", 250, { engineType: "linkedin_owner", status: "draft" })],
      capabilities: [
        { engineType: "maps_deep", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: null, reason: null },
        { engineType: "google_serp", available: false, providerConfigured: true, providerHealthy: false, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: "provider_paused", reason: "provider_paused" },
      ],
      rawNeeded: 500,
      reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"),
      timeZone: "Europe/Madrid",
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ campaignId: "active", engineType: "maps_deep", desiredRawCount: MAX_RAW_PER_PLANNING_WINDOW });
  });

  it("keeps ordinary alternative capacity distinct from Hybrid Fill reroutes", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("maps", 100), campaign("serp", 100, { engineType: "google_serp" })],
      capabilities: [
        { engineType: "maps_fast", available: false, providerConfigured: false, providerHealthy: false, providerUntested: false, costAllowed: false, campaignCount: 1, reasonUnavailable: "provider_not_configured", reason: "provider_not_configured" },
        { engineType: "google_serp", available: true, providerConfigured: true, providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1, reasonUnavailable: null, reason: null },
      ],
      rawNeeded: 60,
      reason: "Apify unavailable; Serper remains available",
      now: new Date("2025-01-01T13:00:00Z"),
      timeZone: "Europe/Madrid",
    });

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ engineType: "google_serp", desiredRawCount: 60, origin: "normal" });
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
    expect(rerouted.reduce((total, order) => total + (order.rebalanceAmount ?? 0), 0))
      .toBe(original.find((order) => order.engineType === "maps_fast")?.desiredRawCount);
    expect(rerouted.some((order) => order.origin === "hybrid_fill")).toBe(true);
  });

  it("reroutes only the Maps campaign selected by Hybrid Fill", () => {
    const campaigns = [campaign("maps-selected", 100), campaign("maps-competitive", 100), campaign("serp", 100, { engineType: "google_serp" })];
    const capabilities = ["maps_fast", "google_serp"].map((engineType) => ({
      engineType: engineType as Campaign["engineType"], available: true, providerConfigured: true,
      providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1,
      reasonUnavailable: null, reason: null,
    }));
    const input = {
      workspaceId: "workspace-1", campaigns, capabilities, rawNeeded: 120, reason: "behind pace",
      now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid",
    };
    const original = allocateEngineWork(input);
    const selectedMapRaw = original.find((order) => order.campaignId === "maps-selected")?.desiredRawCount ?? 0;
    const rerouted = rerouteEngineOrders({
      ...input, orders: original, fromEngine: "maps_fast", fromCampaignIds: ["maps-selected"],
      alternativeCampaignIds: ["serp"], reason: "Maps source underperformed",
    });

    expect(rerouted.find((order) => order.campaignId === "maps-selected")).toBeUndefined();
    expect(rerouted.find((order) => order.campaignId === "maps-competitive")).toMatchObject({ origin: "normal" });
    expect(rerouted.find((order) => order.campaignId === "serp")?.desiredRawCount).toBeGreaterThan(0);
    expect(rerouted.reduce((sum, order) => sum + order.desiredRawCount, 0)).toBe(120);
    expect(rerouted.reduce((sum, order) => sum + (order.rebalanceAmount ?? 0), 0)).toBe(selectedMapRaw);
  });

  it("preserves queue-depth and seed-exhaustion allocation penalties", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("congested", 100), campaign("clear", 100, { engineType: "google_serp" })],
      capabilities: ["maps_fast", "google_serp"].map((engineType) => ({
        engineType: engineType as Campaign["engineType"], available: true, providerConfigured: true,
        providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1,
        reasonUnavailable: null, reason: null,
      })),
      performances: [
        { campaignId: "congested", yield: 0.2, queueDepth: 1_000, seedExhaustion: 0.8 },
        { campaignId: "clear", yield: 0.2, queueDepth: 0, seedExhaustion: 0 },
      ],
      rawNeeded: 100, reason: "behind pace", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid",
    });

    expect(orders.find((order) => order.campaignId === "clear")?.desiredRawCount).toBeGreaterThan(orders.find((order) => order.campaignId === "congested")?.desiredRawCount ?? 0);
  });

  it("allows recovered Maps Fast to re-enter normal allocation when its yield is competitive", () => {
    const orders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns: [campaign("maps", 100), campaign("serp", 100, { engineType: "google_serp" })],
      capabilities: ["maps_fast", "google_serp"].map((engineType) => ({
        engineType: engineType as Campaign["engineType"], available: true, providerConfigured: true,
        providerHealthy: true, providerUntested: false, costAllowed: true, campaignCount: 1,
        reasonUnavailable: null, reason: null,
      })),
      performances: [
        { campaignId: "maps", yield: 0.2, yieldTier: "confirmed_instantly", queueDepth: 0, seedExhaustion: 0 },
        { campaignId: "serp", yield: 0.3, yieldTier: "confirmed_instantly", queueDepth: 0, seedExhaustion: 0 },
      ],
      rawNeeded: 100, reason: "behind pace", now: new Date("2025-01-01T13:00:00Z"), timeZone: "Europe/Madrid",
    });

    expect(orders.find((order) => order.campaignId === "maps"))?.toMatchObject({ origin: "normal" });
  });
});

describe("Apify recovery allocation integration", () => {
  const originalFailures: ApifyRecoveryRun[] = ["10:00:00", "10:00:01", "10:00:02"].map((time) => ({
    status: "failed",
    startedAt: `2026-10-11T${time}.000Z`,
    finishedAt: `2026-10-11T${time}.000Z`,
    itemsReturned: 0,
    costUsd: 0,
    failureKind: "billing" as const,
  }));
  const campaigns = [
    campaign("maps-fast", 100),
    campaign("maps-deep", 100, { engineType: "maps_deep" }),
    campaign("serper", 100, { engineType: "google_serp" }),
  ];
  const now = new Date("2026-10-11T12:00:00.000Z");

  function plan(runs: ApifyRecoveryRun[], latestFailure: ApifyRecoveryRun, time: Date) {
    const latestSuccess = runs
      .filter((run) => ["succeeded", "ingested", "completed"].includes(run.status))
      .sort((left, right) => new Date(right.finishedAt ?? right.startedAt).getTime() - new Date(left.finishedAt ?? left.startedAt).getTime())[0];
    const snapshot = evaluateApifyRecovery(runs, latestFailure, latestSuccess?.finishedAt ?? null, false, false, time);
    const mapsHealth = getApifyAllocationHealth(snapshot);
    const capabilities = buildEngineCapabilities({
      mapsProvider: "apify",
      mapsProviderConfigured: true,
      serpProvider: "serper",
      serpProviderConfigured: true,
      mapsFastHealth: mapsHealth,
      providerHealth: {
        maps_fast: mapsHealth,
        maps_deep: mapsHealth === "paused" ? "paused" : "healthy",
        google_serp: "healthy",
      },
      costAllowed: true,
      mapsCostAllowed: true,
      serperCostAllowed: true,
      campaignCounts: { maps_fast: 1, maps_deep: 1, google_serp: 1 },
    });
    const planningLimit = Math.min(MAX_RAW_PER_PLANNING_WINDOW, 100);
    const probes = planApifyRecoveryProbe({
      workspaceId: "workspace-1",
      campaigns,
      rawNeeded: planningLimit,
      eligible: snapshot.recoveryProbeEligible,
      dailyBudgetAllowed: true,
      cooldownAt: snapshot.nextRecoveryAttemptAt,
      credentialFingerprint: "credential-a",
      failureEpoch: "2026-10-11T11:59:00.000Z",
      now: time,
      timeZone: "Europe/Madrid",
    });
    const normalOrders = allocateEngineWork({
      workspaceId: "workspace-1",
      campaigns,
      capabilities,
      rawNeeded: planningLimit - probes.reduce((total, order) => total + order.desiredRawCount, 0),
      reason: "behind pace",
      now: time,
      timeZone: "Europe/Madrid",
    });
    return { snapshot, mapsHealth, capabilities, probes, normalOrders, planningLimit };
  }

  it("keeps normal Maps allocation paused while allowing one capped probe, then restores normal allocation only after success", () => {
    const cooldown = plan(originalFailures, originalFailures[2]!, new Date("2026-10-11T10:15:00.000Z"));
    expect(cooldown.mapsHealth).toBe("paused");
    expect(cooldown.capabilities.find((item) => item.engineType === "maps_fast")?.available).toBe(false);
    expect(cooldown.normalOrders.map((order) => order.engineType)).toEqual(["google_serp"]);
    expect(cooldown.probes).toHaveLength(0);
    expect(resolveApifyDiscoveryWorkMode({ providerHealth: "paused", recoveryProbeEligible: false, recoveryProbeRequested: false })).toBe("defer");

    const eligible = plan(originalFailures, originalFailures[2]!, now);
    expect(eligible.snapshot.recoveryProbeEligible).toBe(true);
    expect(eligible.snapshot.nextRecoveryAttemptAt?.toISOString()).toBe("2026-10-11T10:30:02.000Z");
    expect(eligible.mapsHealth).toBe("paused");
    expect(eligible.capabilities.find((item) => item.engineType === "maps_fast")?.available).toBe(false);
    expect(eligible.probes).toHaveLength(1);
    expect(eligible.probes[0]).toMatchObject({ engineType: "maps_fast", desiredRawCount: 10, origin: "recovery_probe" });
    expect(resolveApifyDiscoveryWorkMode({ providerHealth: "paused", recoveryProbeEligible: true, recoveryProbeRequested: false })).toBe("skip");
    expect(resolveApifyDiscoveryWorkMode({ providerHealth: "paused", recoveryProbeEligible: true, recoveryProbeRequested: true })).toBe("recovery_probe");
    expect([...eligible.normalOrders, ...eligible.probes].reduce((sum, order) => sum + order.desiredRawCount, 0)).toBe(eligible.planningLimit);
    expect(planApifyRecoveryProbe({
      workspaceId: "workspace-1", campaigns, rawNeeded: 100, eligible: true, dailyBudgetAllowed: true,
      cooldownAt: eligible.snapshot.nextRecoveryAttemptAt, credentialFingerprint: "credential-a", failureEpoch: "2026-10-11T11:59:00.000Z", now, timeZone: "Europe/Madrid",
    })[0]?.idempotencyKey).toBe(eligible.probes[0]?.idempotencyKey);
    expect(planApifyRecoveryProbe({
      workspaceId: "workspace-1", campaigns, rawNeeded: 100, eligible: true, dailyBudgetAllowed: true,
      cooldownAt: eligible.snapshot.nextRecoveryAttemptAt, credentialFingerprint: "credential-b", failureEpoch: "2026-10-11T11:59:00.000Z", now, timeZone: "Europe/Madrid",
    })[0]?.idempotencyKey).not.toBe(eligible.probes[0]?.idempotencyKey);
    expect(planApifyRecoveryProbe({
      workspaceId: "workspace-1", campaigns, rawNeeded: 100, eligible: true, dailyBudgetAllowed: true,
      cooldownAt: eligible.snapshot.nextRecoveryAttemptAt, credentialFingerprint: "credential-a", failureEpoch: "2026-10-11T12:10:00.000Z", now, timeZone: "Europe/Madrid",
    })[0]?.idempotencyKey).not.toBe(eligible.probes[0]?.idempotencyKey);
    expect(planApifyRecoveryProbe({
      workspaceId: "workspace-1", campaigns, rawNeeded: 100, eligible: true, dailyBudgetAllowed: true,
      cooldownAt: new Date("2026-10-11T12:05:00.000Z"), credentialFingerprint: "credential-a",
      failureEpoch: "2026-10-11T11:59:00.000Z", now: new Date("2026-10-11T12:05:00.000Z"), timeZone: "Europe/Madrid",
    })[0]?.idempotencyKey).toBe(eligible.probes[0]?.idempotencyKey);

    const failedProbe = {
      status: "failed",
      startedAt: "2026-10-11T11:59:00.000Z",
      finishedAt: "2026-10-11T11:59:30.000Z",
      itemsReturned: 0,
      costUsd: 0.05,
      recoveryProbe: true,
      failureKind: "transient" as const,
    };
    const afterProbeFailure = plan([...originalFailures, failedProbe], failedProbe, now);
    expect(afterProbeFailure.snapshot.recoveryProbeEligible).toBe(false);
    expect(afterProbeFailure.probes).toHaveLength(0);
    expect(afterProbeFailure.normalOrders.map((order) => order.engineType)).toEqual(["google_serp"]);
    expect(resolveApifyDiscoveryWorkMode({ providerHealth: "paused", recoveryProbeEligible: false, recoveryProbeRequested: true })).toBe("defer");

    const successfulProbe = {
      status: "ingested",
      startedAt: "2026-10-11T11:59:40.000Z",
      finishedAt: "2026-10-11T11:59:50.000Z",
      itemsReturned: 8,
      costUsd: 0.05,
      recoveryProbe: true,
    };
    const recovered = plan([...originalFailures, failedProbe, successfulProbe], failedProbe, now);
    expect(evaluateProviderHealth(recovered.snapshot.usage)).toBe("healthy");
    expect(recovered.mapsHealth).toBe("healthy");
    expect(recovered.probes).toHaveLength(0);
    expect(recovered.normalOrders.some((order) => order.engineType === "maps_fast" || order.engineType === "maps_deep")).toBe(true);
    expect(recovered.normalOrders.every((order) => order.origin !== "recovery_probe")).toBe(true);
    expect(recovered.normalOrders.reduce((sum, order) => sum + order.desiredRawCount, 0)).toBeLessThanOrEqual(recovered.planningLimit);
  });
});
