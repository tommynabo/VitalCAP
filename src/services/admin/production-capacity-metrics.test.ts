import { describe, expect, it } from "vitest";
import {
  calculateCostPerConfirmedImport,
  calculateYield,
  estimateRequestsRequiredForTarget,
  getCapacityWindowBounds,
  rollupConfirmedImports,
  sameCohortYield,
  totalConfirmedImports,
  type AccountEngineSource,
  type ConfirmedImportFact,
} from "./production-capacity-metrics";

const now = new Date("2026-10-09T12:00:00.000Z");
const todayStart = new Date("2026-10-08T22:00:00.000Z");
const source = (accountId: string, engineType: string, workspaceId = "workspace-1"): AccountEngineSource => ({
  workspaceId,
  accountId,
  engineType,
  discoveredAt: new Date("2026-10-09T10:00:00.000Z"),
});
const imported = (accountId: string, uploadedAt: string, overrides: Partial<ConfirmedImportFact> = {}): ConfirmedImportFact => ({
  workspaceId: "workspace-1",
  accountId,
  providerCampaignId: "target-campaign",
  status: "instantly_added",
  providerLeadId: `lead-${accountId}`,
  uploadedAt: new Date(uploadedAt),
  ...overrides,
});

describe("production capacity metrics", () => {
  it("counts imports from a source in the same cohort and separates multi-source accounts", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [imported("account-1", "2026-10-09T10:00:00.000Z"), imported("account-2", "2026-10-09T10:00:00.000Z")],
      sources: [source("account-1", "maps_fast"), source("account-1", "maps_fast"), source("account-2", "maps_fast"), source("account-2", "google_serp")],
    });

    expect(result.byWindow.today.sameCohortByEngine).toEqual({ maps_fast: 1 });
    expect(result.byWindow.today.multiSource).toBe(1);
    expect(sameCohortYield(result.byWindow.today, 100)).toBe(0.01);
  });

  it("separates backlog imports instead of counting them as same-cohort yield", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [imported("backlog", "2026-10-09T10:00:00.000Z")],
      sources: [{ ...source("backlog", "maps_deep"), discoveredAt: new Date("2026-10-01T10:00:00.000Z") }],
    });

    expect(result.byWindow.today.backlogByEngine).toEqual({ maps_deep: 1 });
    expect(result.byWindow.today.sameCohortByEngine).toEqual({});
    expect(sameCohortYield(result.byWindow.today, 100)).toBe(0);
  });

  it("uses Madrid today bounds and rolling 72-hour and 168-hour windows", () => {
    const bounds = getCapacityWindowBounds(now, todayStart);

    expect(bounds.today.start).toEqual(todayStart);
    expect(bounds.today.end).toEqual(now);
    expect(bounds.rolling3d.start.toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(bounds.rolling7d.start.toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  it("counts only confirmed additions to the configured target campaign", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [
        imported("confirmed", "2026-10-09T10:00:00.000Z"),
        imported("skipped", "2026-10-09T10:00:00.000Z", { status: "skipped_existing" }),
        imported("missing-lead-id", "2026-10-09T10:00:00.000Z", { providerLeadId: null }),
        imported("wrong-campaign", "2026-10-09T10:00:00.000Z", { providerCampaignId: "other-campaign" }),
        imported("not-uploaded", "2026-10-09T10:00:00.000Z", { uploadedAt: null }),
      ],
      sources: [source("confirmed", "google_serp"), source("skipped", "google_serp"), source("missing-lead-id", "google_serp"), source("wrong-campaign", "google_serp"), source("not-uploaded", "google_serp")],
    });

    expect(result.byWindow.today.sameCohortByEngine).toEqual({ google_serp: 1 });
    expect(result.byWindow.today.unattributed).toBe(0);
  });

  it("scopes imports and source attribution to the authorized workspace", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [
        imported("account-1", "2026-10-09T10:00:00.000Z"),
        imported("account-2", "2026-10-09T10:00:00.000Z", { workspaceId: "workspace-2" }),
      ],
      sources: [source("account-1", "maps_deep"), source("account-2", "google_serp", "workspace-2")],
    });

    expect(result.byWindow.today.sameCohortByEngine).toEqual({ maps_deep: 1 });
    expect(result.byWindow.today.unattributed).toBe(0);
  });

  it("keeps confirmed imports without explicit account lineage unattributed", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [imported("unlinked", "2026-10-09T10:00:00.000Z")],
      sources: [],
    });

    expect(result.byWindow.today.unattributed).toBe(1);
    expect(totalConfirmedImports(result.byWindow.today)).toBe(1);
  });

  it("does not use source discoveries that occurred after an import upload", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [imported("future-source", "2026-10-09T09:00:00.000Z")],
      sources: [
        source("future-source", "maps_fast"),
        { ...source("future-source", "google_serp"), discoveredAt: new Date("2026-10-09T11:00:00.000Z") },
      ],
    });

    expect(result.byWindow.today.sameCohortByEngine).toEqual({});
    expect(result.byWindow.today.multiSource).toBe(0);
    expect(result.byWindow.today.unattributed).toBe(1);
  });

  it("aligns imports with source dates for each rolling window", () => {
    const result = rollupConfirmedImports({
      workspaceId: "workspace-1",
      targetProviderCampaignId: "target-campaign",
      now,
      todayStart,
      imports: [
        imported("today-source", "2026-10-09T10:00:00.000Z"),
        imported("old-source", "2026-10-09T10:00:00.000Z"),
      ],
      sources: [
        source("today-source", "maps_fast"),
        { ...source("old-source", "maps_fast"), discoveredAt: new Date("2026-10-01T10:00:00.000Z") },
      ],
    });

    expect(result.byWindow.today.sameCohortByEngine.maps_fast).toBe(1);
    expect(result.byWindow.today.backlogByEngine.maps_fast).toBe(1);
    expect(result.byWindow.rolling3d.sameCohortByEngine.maps_fast).toBe(1);
    expect(result.byWindow.rolling3d.backlogByEngine.maps_fast).toBe(1);
    expect(result.byWindow.rolling7d.sameCohortByEngine.maps_fast).toBe(1);
    expect(result.byWindow.rolling7d.backlogByEngine.maps_fast).toBe(1);
  });

  it("returns unknown for missing costs or empty confirmed-import denominators", () => {
    expect(calculateCostPerConfirmedImport(null, 10)).toBeNull();
    expect(calculateCostPerConfirmedImport(1, 0)).toBeNull();
    expect(calculateCostPerConfirmedImport(2, 4)).toBe(0.5);
    expect(calculateYield(0, 0)).toBeNull();
    expect(calculateYield(5, 20)).toBe(0.25);
  });

  it("estimates target request demand from successful daily yield samples", () => {
    expect(estimateRequestsRequiredForTarget([
      { requests: 100, confirmedImports: 10 },
      { requests: 200, confirmedImports: 10 },
      { requests: 300, confirmedImports: 10 },
      { requests: 0, confirmedImports: 10 },
      { requests: 10_000, confirmedImports: 0 },
    ], 250)).toEqual({
      p50: 5_000, p75: 7_500, p90: 7_500,
      p50YieldUsed: 0.05, p75YieldUsed: 1 / 30, p90YieldUsed: 1 / 30, sampleCount: 3,
    });
    expect(estimateRequestsRequiredForTarget([], 250)).toEqual({
      p50: null, p75: null, p90: null,
      p50YieldUsed: null, p75YieldUsed: null, p90YieldUsed: null, sampleCount: 0,
    });
    expect(estimateRequestsRequiredForTarget([{ requests: 100, confirmedImports: 10 }], 250))
      .toMatchObject({ p50: null, p75: null, p90: null, sampleCount: 1 });
  });
});