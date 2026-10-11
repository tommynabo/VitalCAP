export const ENGINE_PERFORMANCE_WINDOW_DAYS = 7;
export const MIN_RAW_SAMPLE_FOR_ENGINE_YIELD = 20;
export const MIN_CONFIRMED_INSTANTLY_IMPORTS_FOR_YIELD = 3;
export const MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD = 5;
export const SAFE_ENGINE_YIELD_PRIOR = 0.1;

export type EngineYieldTier =
  | "confirmed_instantly"
  | "compliance_eligible_exact_mv"
  | "exact_mv"
  | "ready"
  | "neutral_prior";

export interface EnginePerformanceCounts {
  rawCount: number;
  confirmedImportCount: number;
  complianceEligibleExactMvCount: number;
  exactMvValidCount: number;
  readyCount: number;
  estimatedProviderCostUsd: number | null;
}

export interface EnginePerformanceMetric extends EnginePerformanceCounts {
  yield: number;
  yieldTier: EngineYieldTier;
  importRawYield: number | null;
  costPerConfirmedImportUsd: number | null;
}

function boundedYield(numerator: number, denominator: number): number {
  return Math.max(0, Math.min(1, numerator / denominator));
}

export function selectEnginePerformance(counts: EnginePerformanceCounts): EnginePerformanceMetric {
  const rawCount = Math.max(0, counts.rawCount);
  const confirmedImportCount = Math.max(0, counts.confirmedImportCount);
  const importRawYield = rawCount > 0 ? boundedYield(confirmedImportCount, rawCount) : null;
  const costPerConfirmedImportUsd = confirmedImportCount > 0 && counts.estimatedProviderCostUsd !== null
    ? counts.estimatedProviderCostUsd / confirmedImportCount
    : null;

  if (rawCount >= MIN_RAW_SAMPLE_FOR_ENGINE_YIELD && confirmedImportCount >= MIN_CONFIRMED_INSTANTLY_IMPORTS_FOR_YIELD) {
    return { ...counts, rawCount, confirmedImportCount, yield: importRawYield ?? SAFE_ENGINE_YIELD_PRIOR, yieldTier: "confirmed_instantly", importRawYield, costPerConfirmedImportUsd };
  }
  if (rawCount >= MIN_RAW_SAMPLE_FOR_ENGINE_YIELD && counts.complianceEligibleExactMvCount >= MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD) {
    return { ...counts, rawCount, confirmedImportCount, yield: boundedYield(counts.complianceEligibleExactMvCount, rawCount), yieldTier: "compliance_eligible_exact_mv", importRawYield, costPerConfirmedImportUsd };
  }
  if (rawCount >= MIN_RAW_SAMPLE_FOR_ENGINE_YIELD && counts.exactMvValidCount >= MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD) {
    return { ...counts, rawCount, confirmedImportCount, yield: boundedYield(counts.exactMvValidCount, rawCount), yieldTier: "exact_mv", importRawYield, costPerConfirmedImportUsd };
  }
  if (rawCount >= MIN_RAW_SAMPLE_FOR_ENGINE_YIELD && counts.readyCount >= MIN_FALLBACK_OUTCOMES_FOR_ENGINE_YIELD) {
    return { ...counts, rawCount, confirmedImportCount, yield: boundedYield(counts.readyCount, rawCount), yieldTier: "ready", importRawYield, costPerConfirmedImportUsd };
  }
  return { ...counts, rawCount, confirmedImportCount, yield: SAFE_ENGINE_YIELD_PRIOR, yieldTier: "neutral_prior", importRawYield, costPerConfirmedImportUsd };
}