import { describe, expect, it } from "vitest";
import { WATCHDOG_QUEUE_PAUSE_REASON } from "@/services/autopilot/watchdog-pause-policy";
import { canExecuteWatchdogRecoveryJob, getApifyDiscoveryBatchCap, getApifyStartupCostPatch, isAuthorizedScopedProbeExecution, isProviderRunReplayWithoutResults, mergeApifyProviderRunMetadata, resolveScopedColdStartBatches } from "./discovery-runner";
import type { SearchSeed } from "@/domain/discovery/types";
import type { SeedEconomicPerformance } from "@/services/discovery/seed-economics";

describe("watchdog recovery discovery execution", () => {
  const watchdogPausedSettings = {
    enabled: true,
    systemPaused: true,
    systemPauseReason: WATCHDOG_QUEUE_PAUSE_REASON,
    emergencyStopped: false,
  };

  it("executes only a marked recovery claim under the watchdog-owned pause", () => {
    expect(canExecuteWatchdogRecoveryJob(watchdogPausedSettings, { watchdogRecovery: true })).toBe(true);
    expect(canExecuteWatchdogRecoveryJob(watchdogPausedSettings, { watchdogRecovery: false })).toBe(false);
    expect(canExecuteWatchdogRecoveryJob({ ...watchdogPausedSettings, systemPauseReason: "operator_hold" }, { watchdogRecovery: true })).toBe(false);
    expect(canExecuteWatchdogRecoveryJob({ ...watchdogPausedSettings, emergencyStopped: true }, { watchdogRecovery: true })).toBe(false);
    expect(canExecuteWatchdogRecoveryJob({ ...watchdogPausedSettings, enabled: false }, { watchdogRecovery: true })).toBe(false);
  });
});

describe("Serper idempotent discovery replay", () => {
  it("does not account an existing provider run as a new empty ingestion", () => {
    expect(isProviderRunReplayWithoutResults({
      providerRunId: "completed-run",
      providerCalls: 0,
      resultsReturned: 0,
      rawCandidates: [],
    })).toBe(true);
    expect(isProviderRunReplayWithoutResults({
      providerRunId: "completed-run",
      providerCalls: 1,
      resultsReturned: 0,
      rawCandidates: [],
    })).toBe(false);
  });
});

describe("Apify discovery reservation state", () => {
  it("preserves credential and configuration fingerprints through async provider updates", () => {
    const metadata = mergeApifyProviderRunMetadata(
      {
        credentialFingerprint: "safe-credential-fingerprint",
        configurationFingerprint: "safe-configuration-fingerprint",
        recoveryProbe: true,
        normalizedQuery: "cafes madrid",
        planningWindow: "2026-10-24T13:30",
      },
      {
        actorRunIdPresent: true,
        credentialFingerprint: "provider-returned-other-fingerprint",
        configurationFingerprint: "provider-returned-other-configuration",
      },
      { engineType: "maps_fast", niche: "yoga_pilates", seedId: "seed-id", seedRunId: "seed-run-id", discoveryJobId: "job-id" },
    );

    expect(metadata).toMatchObject({
      credentialFingerprint: "safe-credential-fingerprint",
      configurationFingerprint: "safe-configuration-fingerprint",
      recoveryProbe: true,
      normalizedQuery: "cafes madrid",
      planningWindow: "2026-10-24T13:30",
      engineType: "maps_fast",
      niche: "yoga_pilates",
      seedId: "seed-id",
      seedRunId: "seed-run-id",
      discoveryJobId: "job-id",
    });
    expect(JSON.stringify(metadata)).not.toContain("APIFY_API_TOKEN");
  });

  it("records zero actual cost only for definitive failures before external run creation", () => {
    expect(getApifyStartupCostPatch("billing")).toEqual({ costUsd: 0 });
    expect(getApifyStartupCostPatch("authentication")).toEqual({ costUsd: 0 });
    expect(getApifyStartupCostPatch("configuration")).toEqual({ costUsd: 0 });
    expect(getApifyStartupCostPatch("transient")).toEqual({});
    expect(getApifyStartupCostPatch("actor_resource_limit")).toEqual({});
    expect(getApifyStartupCostPatch(null)).toEqual({});
  });

  it("keeps normal Maps discovery above the recovery-probe cap after health is established", () => {
    expect(getApifyDiscoveryBatchCap(true, "paused")).toBe(10);
    expect(getApifyDiscoveryBatchCap(false, "healthy")).toBeGreaterThan(10);
  });
});

describe("scoped cold-start probe planning", () => {
  const seed: SearchSeed = {
    id: "seed-1",
    campaignId: "campaign-1",
    engineType: "google_serp",
    query: "pilates studio",
    geography: "Madrid",
    lastRunAt: null,
    totalRaw: 0,
    totalUnique: 0,
    totalReady: 0,
    yieldRate: 0,
    exhaustionScore: 0,
    nextEligibleAt: null,
  };

  it("creates exactly one <=5-item exploration batch only for an authorized cold-start probe", () => {
    const result = resolveScopedColdStartBatches({
      probeAuthorized: true,
      seed,
      existingBatches: [],
      desiredRawCount: 5,
      now: new Date("2026-11-09T10:00:00.000Z"),
    });
    expect(result.usedColdStartBypass).toBe(true);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({ seed, requestedItems: 5, policy: { exploration: true } });
  });

  it("does not bypass normal scheduler economics", () => {
    const result = resolveScopedColdStartBatches({
      probeAuthorized: false,
      seed,
      existingBatches: [],
      desiredRawCount: 5,
      now: new Date("2026-11-09T10:00:00.000Z"),
    });
    expect(result).toEqual({ batches: [], usedColdStartBypass: false, blockedReason: null });
  });

  it("authorizes probe mode only for the authenticated scoped campaign and exact execution job", () => {
    const scoped = {
      campaignId: "campaign-1",
      jobId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
      allowScopedDraftCampaign: true as const,
      probeMode: true as const,
      smokeExecutionId: "c76e780a-b0a2-4e16-a3ec-e5d8a9197c4c",
    };
    const job = {
      id: scoped.jobId,
      campaignId: scoped.campaignId,
      payload: {
        engineType: "google_serp" as const,
        desiredRawCount: 5,
        probeMode: true,
        scopedSmoke: true,
        smokeExecutionId: scoped.jobId,
        maxProviderQueries: 1,
      },
    };

    expect(isAuthorizedScopedProbeExecution(undefined, job)).toBe(false);
    expect(isAuthorizedScopedProbeExecution(scoped, job)).toBe(true);
    expect(isAuthorizedScopedProbeExecution({ ...scoped, campaignId: "other-campaign" }, job)).toBe(false);
    expect(isAuthorizedScopedProbeExecution({ ...scoped, jobId: "other-job" }, job)).toBe(false);
  });

  it("does not bypass a cooling seed or mature economic evidence", () => {
    const coolingPerformance = {
      recentRuns: 1,
      itemsReturned: 50,
      noveltyRate: 0,
      outcomeAttributionComplete: true,
      confirmedInstantlyImportsFromSeed: 0,
      zeroNoveltyRunStreak: 1,
      lastRunAt: "2026-11-09T09:00:00.000Z",
    } as SeedEconomicPerformance;
    const cooling = resolveScopedColdStartBatches({
      probeAuthorized: true,
      seed,
      performance: coolingPerformance,
      existingBatches: [],
      desiredRawCount: 5,
      now: new Date("2026-11-09T10:00:00.000Z"),
    });
    expect(cooling.blockedReason).toBe("seed_cooldown_or_policy_block");
    expect(cooling.batches).toHaveLength(0);

    const maturePerformance = {
      recentRuns: 3,
      itemsReturned: 60,
      noveltyRate: 0.5,
      outcomeAttributionComplete: true,
    } as SeedEconomicPerformance;
    const mature = resolveScopedColdStartBatches({
      probeAuthorized: true,
      seed,
      performance: maturePerformance,
      existingBatches: [],
      desiredRawCount: 5,
      now: new Date("2026-11-09T10:00:00.000Z"),
    });
    expect(mature.blockedReason).toBe("economic_evidence_mature");
    expect(mature.batches).toHaveLength(0);
  });
});