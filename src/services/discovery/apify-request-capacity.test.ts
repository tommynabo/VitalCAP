import { describe, expect, it } from "vitest";
import { resolveApifyMaxResults } from "./apify-request-capacity";

describe("resolveApifyMaxResults", () => {
  it("keeps a 100-item planner request aligned with a 100-item provider and batch budget", () => {
    expect(resolveApifyMaxResults({ requestedItems: 100, configuredMaxResults: 100, batchCostLimitUsd: 0.5 })).toBe(100);
  });

  it("caps both provider request and reservation capacity at a lower configured maximum", () => {
    expect(resolveApifyMaxResults({ requestedItems: 100, configuredMaxResults: 20, batchCostLimitUsd: 0.5 })).toBe(20);
  });

  it("never exceeds the hard maximum even when the planner asks for more", () => {
    expect(resolveApifyMaxResults({ requestedItems: 150, configuredMaxResults: 150, batchCostLimitUsd: 1 })).toBe(100);
  });

  it("derives the maximum from the protected per-result batch estimate", () => {
    expect(resolveApifyMaxResults({ requestedItems: 150, configuredMaxResults: 150, batchCostLimitUsd: 0.5 })).toBe(100);
  });

  it("returns zero when the budget cannot safely reserve one result", () => {
    expect(resolveApifyMaxResults({ requestedItems: 10, configuredMaxResults: 100, batchCostLimitUsd: 0.004 })).toBe(0);
  });
});