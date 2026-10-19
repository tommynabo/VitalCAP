import { describe, expect, it } from "vitest";
import {
  buildCapacityScenarios,
  calculateCostPerConfirmedImport,
  calculateYield,
  evaluateInstantlyDeliveryCapacity,
  evaluateRampReadiness,
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

const deliveryCapacityInput = (overrides: Partial<Parameters<typeof evaluateInstantlyDeliveryCapacity>[0]> = {}) => ({
  targetLeadsPerDay: 250,
  planningDays: 30,
  uploadedContacts: 427,
  providerContactLimit: 25_000,
  configuredContactHardLimit: 25_000,
  monthlyEmailsSent: 0,
  monthlyEmailLimit: 10_000,
  followupEmailsPerLead: 0,
  ...overrides,
});

describe("production capacity metrics", () => {
  it("supports the initial-email target when contact and monthly capacity cover the 30-day cohort", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput())).toMatchObject({
      projectedNewContacts: 7_500,
      remainingContactSlots: 24_573,
      contactCapacityStatus: "supported",
      projectedInitialMonthlyEmails: 7_500,
      projectedTotalMonthlyEmails: 7_500,
      totalMonthlyEmailShortfall: 0,
      supportsTarget: true,
    });
  });

  it("blocks a target that exceeds monthly email headroom even when contacts fit", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      monthlyEmailsSent: 400,
      monthlyEmailLimit: 5_000,
    }))).toMatchObject({
      contactCapacityStatus: "supported",
      monthlyEmailHeadroom: 4_600,
      monthlyEmailShortfall: 2_900,
      totalEmailCapacityStatus: "blocked",
      supportsTarget: false,
    });
  });

  it("blocks a target that exceeds the effective provider contact quota", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      uploadedContacts: 900,
      providerContactLimit: 1_000,
      configuredContactHardLimit: 1_000,
    }))).toMatchObject({
      remainingContactSlots: 100,
      contactShortfall: 7_400,
      contactCapacityStatus: "blocked",
      supportsTarget: false,
    });
  });

  it("reports both email and contact constraints when both are binding", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      uploadedContacts: 900,
      providerContactLimit: 1_000,
      configuredContactHardLimit: 1_000,
      monthlyEmailsSent: 400,
      monthlyEmailLimit: 5_000,
    }))).toMatchObject({
      contactCapacityStatus: "blocked",
      totalEmailCapacityStatus: "blocked",
      supportsTarget: false,
    });
  });

  it("returns unknown when required provider usage telemetry is unavailable", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      uploadedContacts: null,
      providerContactLimit: null,
      monthlyEmailsSent: null,
    }))).toMatchObject({
      contactCapacityStatus: "unknown",
      monthlyEmailHeadroom: null,
      totalEmailCapacityStatus: "unknown",
      supportsTarget: null,
    });
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      monthlyEmailsSent: null,
    }))).toMatchObject({
      contactCapacityStatus: "supported",
      initialEmailCapacityStatus: "unknown",
      supportsTarget: null,
    });
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      uploadedContacts: null,
      providerContactLimit: null,
    }))).toMatchObject({
      contactCapacityStatus: "unknown",
      totalEmailCapacityStatus: "supported",
      supportsTarget: null,
    });
  });

  it("keeps follow-up volume unknown instead of treating it as zero", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      followupEmailsPerLead: null,
    }))).toMatchObject({
      projectedInitialMonthlyEmails: 7_500,
      projectedTotalMonthlyEmails: null,
      followupEmailsPerLead: null,
      totalEmailCapacityStatus: "unknown",
      supportsTarget: null,
    });
  });

  it("includes a known follow-up multiplier in total monthly send requirements", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({
      monthlyEmailLimit: 20_000,
      followupEmailsPerLead: 2,
    }))).toMatchObject({
      projectedInitialMonthlyEmails: 7_500,
      projectedTotalMonthlyEmails: 22_500,
      totalMonthlyEmailShortfall: 2_500,
      totalEmailCapacityStatus: "blocked",
      supportsTarget: false,
    });
  });

  it("calculates prospective capacity while auto-send is disabled", () => {
    expect(evaluateInstantlyDeliveryCapacity(deliveryCapacityInput({ autoSendEnabled: false })))
      .toMatchObject({ projectedInitialMonthlyEmails: 7_500, supportsTarget: true });
  });

  it("requires delivery, provider, pause, dead-letter, raw-cap, and yield gates to be ready", () => {
    expect(evaluateRampReadiness({
      deliveryCapacity: "blocked",
      providersHealthy: false,
      paused: false,
      systemicDeadLetterCount: 0,
      rawCapHealthy: false,
      yieldSampleCount: 6,
    })).toEqual({
      decision: "BLOCKED",
      blockers: ["instantly_delivery_capacity", "provider_health", "raw_request_cap"],
      unknowns: [],
    });
  });

  it("does not mark incomplete ramp evidence as safe", () => {
    expect(evaluateRampReadiness({
      deliveryCapacity: "supported",
      providersHealthy: null,
      paused: null,
      systemicDeadLetterCount: null,
      rawCapHealthy: null,
      yieldSampleCount: 2,
    })).toMatchObject({
      decision: "BLOCKED",
      blockers: ["yield_sample_sufficiency"],
      unknowns: ["provider_health", "autopilot_pause_state", "systemic_dead_letters", "raw_request_cap"],
    });
  });

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
      p25: 2_500,
      p50: 5_000, p75: 7_500, p90: 7_500,
      p25YieldUsed: 0.1,
      p50YieldUsed: 0.05, p75YieldUsed: 1 / 30, p90YieldUsed: 1 / 30, sampleCount: 3,
    });
    expect(estimateRequestsRequiredForTarget([], 250)).toEqual({
      p25: null,
      p50: null, p75: null, p90: null,
      p25YieldUsed: null,
      p50YieldUsed: null, p75YieldUsed: null, p90YieldUsed: null, sampleCount: 0,
    });
    expect(estimateRequestsRequiredForTarget([{ requests: 100, confirmedImports: 10 }], 250))
      .toMatchObject({ p50: null, p75: null, p90: null, sampleCount: 1 });
  });

  it("projects buffered provider requests and costs from the measured rolling mix", () => {
    const estimates = estimateRequestsRequiredForTarget([
      { requests: 100, confirmedImports: 10 },
      { requests: 200, confirmedImports: 10 },
      { requests: 300, confirmedImports: 10 },
    ], 250);
    const scenarios = buildCapacityScenarios({
      estimates,
      rolling7d: {
        finalYield: 0.05,
        totalRequests: 1_000,
        apifyRequests: 750,
        serperRequests: 250,
        apifySpendUsd: 7,
        serperSpendUsd: 1.4,
        verificationSpendUsd: 0.7,
      },
    });

    expect(scenarios.CONSERVATIVE).toMatchObject({
      expectedFinalYield: 1 / 30,
      rawRequestsFor250: 7_500,
      rawRequestsWith20PercentBuffer: 9_000,
      apifyRequests: 6_750,
      serperRequests: 2_250,
      apifyDailyCostUsd: 63,
      serperDailyCostUsd: 12.6,
      verificationDailyCostUsd: 6.3,
    });
    expect(scenarios.BASE.rawRequestsFor250).toBe(5_000);
    expect(scenarios.OPTIMISTIC.rawRequestsFor250).toBe(2_500);
  });

  it("uses the measured rolling-seven-day yield for the base request requirement", () => {
    const estimates = estimateRequestsRequiredForTarget([
      { requests: 100, confirmedImports: 10 },
      { requests: 200, confirmedImports: 10 },
      { requests: 300, confirmedImports: 10 },
    ], 250);
    const scenarios = buildCapacityScenarios({
      estimates,
      rolling7d: {
        finalYield: 0.0124,
        totalRequests: 1_000,
        apifyRequests: 750,
        serperRequests: 250,
        apifySpendUsd: 7,
        serperSpendUsd: 1.4,
        verificationSpendUsd: 0.7,
      },
    });

    expect(scenarios.BASE.rawRequestsFor250).toBe(20_162);
    expect(scenarios.BASE.rawRequestsWith20PercentBuffer).toBe(24_195);
  });
});