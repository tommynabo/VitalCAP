import { describe, expect, it } from "vitest";
import { evaluateProviderHealth, hasUnavailableRequiredDiscoveryProvider, isProviderAvailableForDiscovery } from "./provider-health";

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