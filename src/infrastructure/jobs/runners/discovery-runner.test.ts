import { describe, expect, it } from "vitest";
import { getApifyDiscoveryBatchCap, getApifyStartupCostPatch, mergeApifyProviderRunMetadata } from "./discovery-runner";

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
      { engineType: "maps_fast", seedId: "seed-id", seedRunId: "seed-run-id", discoveryJobId: "job-id" },
    );

    expect(metadata).toMatchObject({
      credentialFingerprint: "safe-credential-fingerprint",
      configurationFingerprint: "safe-configuration-fingerprint",
      recoveryProbe: true,
      normalizedQuery: "cafes madrid",
      planningWindow: "2026-10-24T13:30",
      engineType: "maps_fast",
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