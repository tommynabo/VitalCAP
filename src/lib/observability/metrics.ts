/**
 * Core funnel/operational metrics (Prompt 6 §6.2). Pure aggregation over
 * counts the caller already has (from job/queue/provider-usage records) —
 * this module has no I/O and no knowledge of where those counts come from,
 * so it works the same whether they're read from Supabase or dev-seed
 * fixtures.
 */

export interface FunnelCounts {
  discoveryProviderCalls: number;
  rawCandidates: number;
  uniqueCandidates: number;
  enrichmentAttempts: number;
  enrichmentSuccesses: number;
  emailsSearched: number;
  emailsFound: number;
  verificationAttempts: number;
  verificationSuccesses: number;
  processedCandidates: number;
  readyCandidates: number;
  queuedSends: number;
  sentMessages: number;
  bouncedMessages: number;
  repliedMessages: number;
  meetingsBooked: number;
}

export interface FunnelMetrics {
  discoveryCalls: number;
  rawYield: number;
  uniqueYield: number;
  enrichmentSuccessRate: number;
  emailFindRate: number;
  verificationSuccessRate: number;
  readyRate: number;
  sendRate: number;
  bounceRate: number;
  replyRate: number;
  meetingRate: number;
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Computes every §6.2 funnel rate, guarding every division against a zero denominator. */
export function computeFunnelMetrics(counts: FunnelCounts): FunnelMetrics {
  return {
    discoveryCalls: counts.discoveryProviderCalls,
    rawYield: counts.rawCandidates,
    uniqueYield: counts.uniqueCandidates,
    enrichmentSuccessRate: safeRate(counts.enrichmentSuccesses, counts.enrichmentAttempts),
    emailFindRate: safeRate(counts.emailsFound, counts.emailsSearched),
    verificationSuccessRate: safeRate(counts.verificationSuccesses, counts.verificationAttempts),
    readyRate: safeRate(counts.readyCandidates, counts.processedCandidates),
    sendRate: safeRate(counts.sentMessages, counts.queuedSends),
    bounceRate: safeRate(counts.bouncedMessages, counts.sentMessages),
    replyRate: safeRate(counts.repliedMessages, counts.sentMessages),
    meetingRate: safeRate(counts.meetingsBooked, counts.repliedMessages),
  };
}

export interface ProviderCostSummary {
  provider: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  costUsd: number;
}

/** Provider latency/error/cost metrics (§6.2), one row per provider usage record. */
export function summarizeProviderUsage(
  usageByProvider: Record<string, { calls: number; errors: number; totalLatencyMs: number; costUsd: number }>,
): ProviderCostSummary[] {
  return Object.entries(usageByProvider).map(([provider, usage]) => ({
    provider,
    calls: usage.calls,
    errors: usage.errors,
    errorRate: safeRate(usage.errors, usage.calls),
    avgLatencyMs: usage.calls > 0 ? usage.totalLatencyMs / usage.calls : 0,
    costUsd: usage.costUsd,
  }));
}
