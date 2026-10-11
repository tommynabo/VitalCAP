import { describe, expect, it } from "vitest";
import { MIN_CONFIRMED_INSTANTLY_IMPORTS_FOR_YIELD, MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD, MIN_RAW_SAMPLE_FOR_ENGINE_YIELD, SAFE_ENGINE_YIELD_PRIOR, selectEnginePerformance } from "./engine-performance";

function counts(overrides: Partial<Parameters<typeof selectEnginePerformance>[0]> = {}) {
  return {
    rawCount: 100,
    confirmedImportCount: MIN_CONFIRMED_INSTANTLY_IMPORTS_FOR_YIELD,
    complianceEligibleExactMvCount: 35,
    exactMvValidCount: 50,
    readyCount: 60,
    estimatedProviderCostUsd: 12,
    ...overrides,
  };
}

describe("engine performance selection", () => {
  it("uses confirmed target imports per attributable raw candidate at the sample threshold", () => {
    const performance = selectEnginePerformance(counts({
      rawCount: MIN_RAW_SAMPLE_FOR_ENGINE_YIELD,
      confirmedImportCount: MIN_CONFIRMED_INSTANTLY_IMPORTS_FOR_YIELD,
    }));

    expect(performance).toMatchObject({ yield: 3 / 20, yieldTier: "confirmed_instantly", importRawYield: 3 / 20, costPerConfirmedImportUsd: 4 });
  });

  it("falls back to the compliance-eligible exact-MV sample when confirmed imports are sparse", () => {
    const performance = selectEnginePerformance(counts({ confirmedImportCount: 2 }));

    expect(performance).toMatchObject({ yield: 0.35, yieldTier: "compliance_eligible_exact_mv", importRawYield: 0.02 });
  });

  it("uses exact-MV validity and then ready yield when higher tiers lack enough outcomes", () => {
    const exactMv = selectEnginePerformance(counts({
      confirmedImportCount: 0,
      complianceEligibleExactMvCount: MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD - 1,
      exactMvValidCount: MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD,
    }));
    const ready = selectEnginePerformance(counts({
      confirmedImportCount: 0,
      complianceEligibleExactMvCount: MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD - 1,
      exactMvValidCount: MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD - 1,
      readyCount: MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD,
    }));

    expect(exactMv).toMatchObject({ yieldTier: "exact_mv", yield: 0.05 });
    expect(ready).toMatchObject({ yieldTier: "ready", yield: 0.05 });
  });

  it("uses the conservative neutral prior when the raw sample is too small", () => {
    const performance = selectEnginePerformance(counts({ rawCount: MIN_RAW_SAMPLE_FOR_ENGINE_YIELD - 1 }));

    expect(performance).toMatchObject({ yield: SAFE_ENGINE_YIELD_PRIOR, yieldTier: "neutral_prior" });
  });

  it("keeps costs visible without inventing cost per import when there are no confirmations", () => {
    const performance = selectEnginePerformance(counts({ confirmedImportCount: 0 }));

    expect(performance).toMatchObject({ estimatedProviderCostUsd: 12, costPerConfirmedImportUsd: null });
  });
});