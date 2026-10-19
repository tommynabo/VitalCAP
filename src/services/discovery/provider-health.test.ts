import { describe, expect, it } from "vitest";
import { aggregateProviderHealthSnapshots, buildProviderHealthSnapshot, createApifyConfigurationFingerprint, createApifyCredentialFingerprint, evaluateApifyRecovery, evaluateProviderHealth, getApifyAllocationHealth, hasUnavailableRequiredDiscoveryProvider, isProviderAvailableForDiscovery, resolveApifyDiscoveryWorkMode } from "./provider-health";

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
  const currentConfiguration = {
    APIFY_BATCH_COST_LIMIT_USD: 0.5,
    APIFY_MAPS_FAST_ACTOR: "compass/fast",
    APIFY_MAPS_DEEP_ACTOR: "compass/deep",
    APIFY_MAPS_FALLBACK_ACTOR: "compass/fallback",
  };
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

  it("keeps a billing pause local to Apify while healthy Serper remains allocatable", () => {
    const billingFailure = {
      ...failedRun,
      startedAt: "2026-10-11T11:50:00.000Z",
      finishedAt: "2026-10-11T11:51:00.000Z",
    };
    const snapshot = evaluateApifyRecovery([billingFailure], billingFailure, null, false, false, new Date("2026-10-11T11:55:00.000Z"));

    expect(getApifyAllocationHealth(snapshot)).toBe("paused");
    expect(isProviderAvailableForDiscovery(true, "healthy", 1)).toBe(true);
  });

  it("allows one bounded immediate probe when the Apify credential fingerprint changes", () => {
    const oldCredentialFingerprint = createApifyCredentialFingerprint("old-test-token");
    const newCredentialFingerprint = createApifyCredentialFingerprint("new-test-token");
    const authenticationFailure = {
      ...failedRun,
      startedAt: "2026-10-11T11:58:00.000Z",
      finishedAt: "2026-10-11T11:59:00.000Z",
      failureKind: "authentication" as const,
      credentialFingerprint: oldCredentialFingerprint!,
    };
    const now = new Date("2026-10-11T12:00:00.000Z");
    const snapshot = evaluateApifyRecovery(
      [authenticationFailure], authenticationFailure, null, false, false, now, newCredentialFingerprint,
    );
    const legacyFailure = { ...authenticationFailure, credentialFingerprint: undefined };
    const legacySnapshot = evaluateApifyRecovery(
      [legacyFailure], legacyFailure, null, false, false, now, newCredentialFingerprint,
    );

    expect(newCredentialFingerprint).not.toBe("new-test-token");
    expect(snapshot.recoveryProbeEligible).toBe(true);
    expect(legacySnapshot.recoveryProbeEligible).toBe(true);
    expect(getApifyAllocationHealth(snapshot)).toBe("paused");
    expect(resolveApifyDiscoveryWorkMode({
      providerHealth: getApifyAllocationHealth(snapshot),
      recoveryProbeEligible: snapshot.recoveryProbeEligible,
      recoveryProbeRequested: true,
    })).toBe("recovery_probe");

    const inFlight = evaluateApifyRecovery(
      [authenticationFailure], authenticationFailure, null, true, false, now, newCredentialFingerprint,
    );
    expect(inFlight.recoveryProbeEligible).toBe(false);
  });

  it("allows an immediate probe when a billing failure has an old credential fingerprint", () => {
    const oldCredentialFingerprint = createApifyCredentialFingerprint("old-test-token");
    const newCredentialFingerprint = createApifyCredentialFingerprint("new-test-token");
    const billingFailure = {
      ...failedRun,
      startedAt: "2026-10-11T11:58:00.000Z",
      finishedAt: "2026-10-11T11:59:00.000Z",
      credentialFingerprint: oldCredentialFingerprint!,
    };
    const snapshot = evaluateApifyRecovery(
      [billingFailure], billingFailure, null, false, false, now, newCredentialFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(true);
  });

  it("creates a deterministic fingerprint from the safe Apify configuration only", () => {
    const fingerprint = createApifyConfigurationFingerprint(currentConfiguration);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createApifyConfigurationFingerprint({ ...currentConfiguration })).toBe(fingerprint);
    expect(createApifyConfigurationFingerprint({
      ...currentConfiguration,
      APIFY_BATCH_COST_LIMIT_USD: 0.75,
    })).not.toBe(fingerprint);
  });

  it("keeps an unchanged configuration failure blocked", () => {
    const configurationFingerprint = createApifyConfigurationFingerprint(currentConfiguration);
    const configurationFailure = {
      ...failedRun,
      failureKind: "configuration" as const,
      configurationFingerprint,
    };
    const snapshot = evaluateApifyRecovery(
      [configurationFailure], configurationFailure, null, false, false, now, null, configurationFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(snapshot.nextRecoveryAttemptAt).toBeNull();
  });

  it("allows one immediate bounded probe after a configuration change", () => {
    const oldConfigurationFingerprint = createApifyConfigurationFingerprint({
      ...currentConfiguration,
      APIFY_BATCH_COST_LIMIT_USD: 0.25,
    });
    const currentConfigurationFingerprint = createApifyConfigurationFingerprint(currentConfiguration);
    const configurationFailure = {
      ...failedRun,
      failureKind: "configuration" as const,
      configurationFingerprint: oldConfigurationFingerprint,
    };
    const snapshot = evaluateApifyRecovery(
      [configurationFailure], configurationFailure, null, false, false, now, null, currentConfigurationFingerprint,
    );
    const inFlight = evaluateApifyRecovery(
      [configurationFailure], configurationFailure, null, true, false, now, null, currentConfigurationFingerprint,
    );
    const safetyBlocked = evaluateApifyRecovery(
      [configurationFailure], configurationFailure, null, false, true, now, null, currentConfigurationFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(true);
    expect(snapshot.nextRecoveryAttemptAt?.toISOString()).toBe(now.toISOString());
    expect(inFlight.recoveryProbeEligible).toBe(false);
    expect(safetyBlocked.recoveryProbeEligible).toBe(false);
  });

  it("allows one immediate opportunity for a legacy configuration failure", () => {
    const currentConfigurationFingerprint = createApifyConfigurationFingerprint(currentConfiguration);
    const legacyFailure = { ...failedRun, failureKind: "configuration" as const };
    const firstSnapshot = evaluateApifyRecovery(
      [legacyFailure], legacyFailure, null, false, false, now, null, currentConfigurationFingerprint,
    );
    const persistedFailure = { ...legacyFailure, configurationFingerprint: currentConfigurationFingerprint };
    const afterReservation = evaluateApifyRecovery(
      [persistedFailure], persistedFailure, null, false, false, now, null, currentConfigurationFingerprint,
    );

    expect(firstSnapshot.recoveryProbeEligible).toBe(true);
    expect(afterReservation.recoveryProbeEligible).toBe(false);
    expect(afterReservation.nextRecoveryAttemptAt).toBeNull();
  });

  it("allows an immediate probe for a legacy billing failure without a fingerprint", () => {
    const newCredentialFingerprint = createApifyCredentialFingerprint("new-test-token");
    const legacyBillingFailure = {
      ...failedRun,
      startedAt: "2026-10-11T11:58:00.000Z",
      finishedAt: "2026-10-11T11:59:00.000Z",
    };
    const snapshot = evaluateApifyRecovery(
      [legacyBillingFailure], legacyBillingFailure, null, false, false, now, newCredentialFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(true);
  });

  it("keeps the 30-minute cooldown for a billing failure with the same credential", () => {
    const credentialFingerprint = createApifyCredentialFingerprint("same-test-token");
    const billingFailure = {
      ...failedRun,
      startedAt: "2026-10-11T11:58:00.000Z",
      finishedAt: "2026-10-11T11:59:00.000Z",
      credentialFingerprint: credentialFingerprint!,
    };
    const snapshot = evaluateApifyRecovery(
      [billingFailure], billingFailure, null, false, false,
      new Date("2026-10-11T12:15:00.000Z"), credentialFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(snapshot.nextRecoveryAttemptAt?.toISOString()).toBe("2026-10-11T12:29:00.000Z");
  });

  it("re-enters the auth cooldown when the new credential probe fails authentication", () => {
    const newCredentialFingerprint = createApifyCredentialFingerprint("new-test-token");
    const failedNewCredentialProbe = {
      ...failedRun,
      startedAt: "2026-10-11T12:00:00.000Z",
      finishedAt: "2026-10-11T12:01:00.000Z",
      failureKind: "authentication" as const,
      credentialFingerprint: newCredentialFingerprint!,
      recoveryProbe: true,
    };
    const snapshot = evaluateApifyRecovery(
      [failedNewCredentialProbe], failedNewCredentialProbe, null, false, false,
      new Date("2026-10-11T12:02:00.000Z"), newCredentialFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(snapshot.nextRecoveryAttemptAt?.toISOString()).toBe("2026-10-11T18:01:00.000Z");
  });

  it("re-enters the billing cooldown when the new credential probe fails billing", () => {
    const newCredentialFingerprint = createApifyCredentialFingerprint("new-test-token");
    const failedNewCredentialProbe = {
      ...failedRun,
      startedAt: "2026-10-11T12:00:00.000Z",
      finishedAt: "2026-10-11T12:01:00.000Z",
      credentialFingerprint: newCredentialFingerprint!,
      recoveryProbe: true,
    };
    const snapshot = evaluateApifyRecovery(
      [failedNewCredentialProbe], failedNewCredentialProbe, null, false, false,
      new Date("2026-10-11T12:02:00.000Z"), newCredentialFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(snapshot.nextRecoveryAttemptAt?.toISOString()).toBe("2026-10-11T12:31:00.000Z");
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
    expect(getApifyAllocationHealth(snapshot)).toBe("healthy");
    expect(isProviderAvailableForDiscovery(true, getApifyAllocationHealth(snapshot), 1)).toBe(true);
  });

  it("restores normal health after a successful configuration recovery probe", () => {
    const oldConfigurationFingerprint = createApifyConfigurationFingerprint({
      ...currentConfiguration,
      APIFY_BATCH_COST_LIMIT_USD: 0.25,
    });
    const currentConfigurationFingerprint = createApifyConfigurationFingerprint(currentConfiguration);
    const configurationFailure = {
      ...failedRun,
      failureKind: "configuration" as const,
      configurationFingerprint: oldConfigurationFingerprint,
    };
    const probeSucceeded = {
      ...failedRun,
      status: "ingested",
      startedAt: "2026-10-11T11:45:00.000Z",
      finishedAt: "2026-10-11T11:50:00.000Z",
      itemsReturned: 8,
      costUsd: 0.1,
      recoveryProbe: true,
      configurationFingerprint: currentConfigurationFingerprint,
    };
    const snapshot = evaluateApifyRecovery(
      [configurationFailure, probeSucceeded], configurationFailure, probeSucceeded.finishedAt,
      false, false, now, null, currentConfigurationFingerprint,
    );

    expect(snapshot.recoveryProbeEligible).toBe(false);
    expect(evaluateProviderHealth(snapshot.usage)).toBe("healthy");
    expect(getApifyAllocationHealth(snapshot)).toBe("healthy");
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

  it("retains a failed provider outage beyond the recent-usage window until a success or probe", () => {
    const oldFailure = {
      ...failedRun,
      startedAt: "2026-10-08T10:00:00.000Z",
      finishedAt: "2026-10-08T10:01:00.000Z",
    };
    const beforeCooldown = evaluateApifyRecovery([], oldFailure, null, false, false, new Date("2026-10-08T10:15:00.000Z"));
    expect(beforeCooldown.recoveryProbeEligible).toBe(false);
    expect(getApifyAllocationHealth(beforeCooldown)).toBe("paused");
    expect(resolveApifyDiscoveryWorkMode({
      providerHealth: getApifyAllocationHealth(beforeCooldown),
      recoveryProbeEligible: beforeCooldown.recoveryProbeEligible,
      recoveryProbeRequested: false,
    })).toBe("defer");

    const afterCooldown = evaluateApifyRecovery([], oldFailure, null, false, false, new Date("2026-10-08T10:31:00.000Z"));
    expect(afterCooldown.recoveryProbeEligible).toBe(true);
    expect(getApifyAllocationHealth(afterCooldown)).toBe("paused");

    const afterSuccess = evaluateApifyRecovery([], oldFailure, "2026-10-08T10:32:00.000Z", false, false, new Date("2026-10-08T10:33:00.000Z"));
    expect(afterSuccess.recoveryProbeEligible).toBe(false);
    expect(getApifyAllocationHealth(afterSuccess)).toBe("untested");
  });
});

describe("shared provider health snapshots", () => {
  const usage = (calls: number, errors: number) => ({
    calls,
    errors,
    items: 0,
    totalLatencyMs: 0,
    costUsd: 0,
    quotaRemaining: null,
  });

  it("reports a healthy Apify provider as reliable, allocatable, and available", () => {
    const snapshot = buildProviderHealthSnapshot({
      provider: "apify",
      configured: true,
      budgetAllowed: true,
      usage: usage(5, 0),
      recovery: { usage: usage(5, 0), recoveryProbeEligible: false, nextRecoveryAttemptAt: null },
    });

    expect(snapshot).toMatchObject({
      reliabilityHealth: "healthy",
      allocationHealth: "healthy",
      providerAvailable: true,
      recentTerminalCalls: 5,
      recentErrors: 0,
      recentErrorRate: 0,
    });
  });

  it("keeps recent reliability degraded while allowing allocation after recovery", () => {
    const recoveredRun = {
      status: "succeeded",
      startedAt: "2026-10-11T10:59:00Z",
      finishedAt: "2026-10-11T11:00:00Z",
      itemsReturned: 5,
      costUsd: 0.1,
    };
    const recovery = evaluateApifyRecovery(
      [recoveredRun],
      { status: "failed", startedAt: "2026-10-11T10:00:00Z", finishedAt: "2026-10-11T10:01:00Z", itemsReturned: 0, costUsd: 0 },
      "2026-10-11T11:00:00Z",
      false,
      false,
      new Date("2026-10-11T11:05:00Z"),
    );
    const snapshot = buildProviderHealthSnapshot({
      provider: "apify",
      configured: true,
      budgetAllowed: true,
      usage: usage(10, 3),
      recovery: { ...recovery, latestFailureAt: "2026-10-11T10:01:00Z", latestSuccessAt: "2026-10-11T11:00:00Z" },
    });

    expect(snapshot).toMatchObject({
      reliabilityHealth: "degraded",
      allocationHealth: "healthy",
      providerAvailable: true,
      recentErrorRate: 0.3,
      recoveredAfterLatestFailure: true,
    });
  });

  it.each([
    ["billing failure cooldown", false, new Date("2026-10-11T12:30:00Z")],
    ["eligible recovery probe", true, null],
  ])("pauses allocation for an active %s", (_label, recoveryProbeEligible, nextRecoveryAttemptAt) => {
    const snapshot = buildProviderHealthSnapshot({
      provider: "apify",
      configured: true,
      budgetAllowed: true,
      usage: usage(4, 0),
      recovery: {
        usage: usage(0, 0),
        recoveryProbeEligible: Boolean(recoveryProbeEligible),
        nextRecoveryAttemptAt,
      },
    });

    expect(snapshot.allocationHealth).toBe("paused");
    expect(snapshot.providerAvailable).toBe(false);
  });

  it("blocks allocation when budget or safety is blocked", () => {
    const recovery = { usage: usage(5, 0), recoveryProbeEligible: false, nextRecoveryAttemptAt: null };
    const budgetBlocked = buildProviderHealthSnapshot({
      provider: "apify", configured: true, budgetAllowed: false, usage: usage(5, 0), recovery,
    });
    const safetyBlocked = buildProviderHealthSnapshot({
      provider: "apify", configured: true, budgetAllowed: true, usage: usage(5, 0), recovery: { ...recovery, safetyBlocked: true },
    });

    expect(budgetBlocked).toMatchObject({ allocationHealth: "paused", providerAvailable: false, budgetAllowed: false });
    expect(safetyBlocked).toMatchObject({ allocationHealth: "paused", providerAvailable: false });
  });

  it("keeps Serper reliability and allocation health coherent", () => {
    const snapshot = buildProviderHealthSnapshot({
      provider: "serper", configured: true, budgetAllowed: true, usage: usage(20, 0),
    });

    expect(snapshot).toMatchObject({ reliabilityHealth: "healthy", allocationHealth: "healthy", providerAvailable: true });
  });

  it("aggregates usage totals and never hides a workspace with unavailable allocation", () => {
    const healthy = buildProviderHealthSnapshot({
      provider: "apify", configured: true, budgetAllowed: true, usage: usage(20, 0),
      recovery: { usage: usage(20, 0), recoveryProbeEligible: false, nextRecoveryAttemptAt: null },
    });
    const blocked = buildProviderHealthSnapshot({
      provider: "apify", configured: true, budgetAllowed: true, usage: usage(13, 3),
      recovery: { usage: usage(0, 0), recoveryProbeEligible: true, nextRecoveryAttemptAt: null },
    });
    const aggregate = aggregateProviderHealthSnapshots([healthy, blocked]);

    expect(aggregate).toMatchObject({
      reliabilityHealth: "degraded",
      allocationHealth: "paused",
      providerAvailable: false,
      recentTerminalCalls: 33,
      recentErrors: 3,
      recentErrorRate: 3 / 33,
    });
  });
});