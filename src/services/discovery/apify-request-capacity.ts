export const APIFY_MAX_RESULTS_PER_SEARCH = 100;
export const APIFY_ESTIMATED_COST_PER_REQUESTED_RESULT_USD = 0.005;
export const APIFY_DEFAULT_BATCH_COST_LIMIT_USD = 0.5;

export function resolveApifyMaxResults(input: {
  requestedItems: number;
  batchCostLimitUsd: number;
  configuredMaxResults: number;
}): number {
  const requested = Math.max(0, Math.floor(input.requestedItems));
  const configuredMaximum = Math.max(0, Math.floor(input.configuredMaxResults));
  const budgetMaximum = Math.floor(
    Math.max(0, input.batchCostLimitUsd) / APIFY_ESTIMATED_COST_PER_REQUESTED_RESULT_USD,
  );
  return Math.min(requested, configuredMaximum, budgetMaximum, APIFY_MAX_RESULTS_PER_SEARCH);
}