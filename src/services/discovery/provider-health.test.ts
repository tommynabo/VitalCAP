import { describe, expect, it } from "vitest";
import { evaluateApifyRecovery, evaluateProviderHealth, hasUnavailableRequiredDiscoveryProvider, isProviderAvailableForDiscovery } from "./provider-health";

describe("provider health cold start", () => {
  it("reports zero historical calls as untested", () => {
    expect(evaluateProviderHealth({ calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null })).toBe("untested");
  });

  it("does not turn budget refusal into a provider failure", () => {
    expect(evaluateProviderHealth({ calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null })).not.toBe("degraded");
  });

  it("treats the first terminal success as healthy", () => {
    expect(evaluateProviderHealth({ calls: 1, items: 10, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null })).toBe("healthy");
  });

  it("counts terminal failure outcomes as provider errors", () => {
    expect(evaluateProviderHealth({ calls: 3, items: 0, errors: 2, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null })).toBe("paused");
  });
});

describe("required discovery provider health", () => {
  it("degrades only for a provider required by an active engine", () => {
    expect(hasUnavailableRequiredDiscoveryProvider(["google_serp"], true, false)).toBe(true);
    expect(hasUnavailableRequiredDiscoveryProvider(["maps_fast"], false, true)).toBe(true);
    expect(hasUnavailableRequiredDiscoveryProvider(["maps_fast"], true, false)).toBe(false);
    expect(hasUnavailableRequiredDiscoveryProvider(["hybrid_fill"], false, true)).toBe(false);
  });

  it("counts only configured healthy or untested providers with remaining budget as capacity", () => {
    expect(isProviderAvailableForDiscovery(true, "healthy", 1)).toBe(true);
    expect(isProviderAvailableForDiscovery(true, "untested", 1)).toBe(true);
    expect(isProviderAvailableForDiscovery(true, "degraded", 1)).toBe(false);
    expect(isProviderAvailableForDiscovery(true, "paused", 1)).toBe(false);
    expect(isProviderAvailableForDiscovery(true, "healthy", 0.0005, 0.001)).toBe(false);
  });
});

describe("Apify recovery health", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  const failedRun = {
    status: "failed",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:01:00.000Z",
    itemsReturned: 0,
    costUsd: 0,
    failureKind: "billing" as const,
  };

  it("keeps health paused during cooldown and enables an untested bootstrap only after cooldown", () => {
    const repeatedFailures = [failedRun, failedRun, failedRun];
    const inCooldown = evaluateApifyRecovery(repeatedFailures, failedRun, null, false, false, new Date("2026-10-11T10:15:00.000Z"));
    expect(evaluateProviderHealth(inCooldown.usage)).toBe("paused");
    expect(inCooldown.recoveryProbeEligible).toBe(false);

    const ready = evaluateApifyRecovery(repeatedFailures, failedRun, null, false, false, now);
    expect(evaluateProviderHealth(ready.usage)).toBe("untested");
    expect(ready.recoveryProbeEligible).toBe(true);
  });

  it("does not enable a second probe while the bounded recovery run is active", () => {
    const snapshot = evaluateApifyRecovery([failedRun, failedRun, failedRun], failedRun, null, true, false, now);
    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(snapshot.nextRecoveryAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  it("restores normal health after a successful recovery probe", () => {
    const probeSucceeded = {
      status: "ingested",
      startedAt: "2026-10-11T11:45:00.000Z",
      finishedAt: "2026-10-11T11:50:00.000Z",
      itemsReturned: 8,
      costUsd: 0.1,
      recoveryProbe: true,
    };
    const snapshot = evaluateApifyRecovery([failedRun, probeSucceeded], failedRun, probeSucceeded.finishedAt, false, false, now);
    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(evaluateProviderHealth(snapshot.usage)).toBe("healthy");
  });

  it("re-enters cooldown after a failed probe and honors the safety gate", () => {
    const failedProbe = { ...failedRun, startedAt: "2026-10-11T11:45:00.000Z", finishedAt: "2026-10-11T11:46:00.000Z", recoveryProbe: true };
    const priorFailures = [failedRun, failedRun, failedRun];
    const cooldown = evaluateApifyRecovery([...priorFailures, failedProbe], failedProbe, null, false, false, now);
    expect(cooldown.recoveryProbeEligible).toBe(false);
    expect(cooldown.nextRecoveryAttemptAt?.toISOString()).toBe("2026-10-11T12:16:00.000Z");

    const blocked = evaluateApifyRecovery([...priorFailures, failedProbe], failedProbe, null, false, true, new Date("2026-10-11T13:00:00.000Z"));
    expect(blocked.recoveryProbeEligible).toBe(false);
  });
});