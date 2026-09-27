import { describe, expect, it } from "vitest";
import { evaluateProviderHealth } from "./provider-health";

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