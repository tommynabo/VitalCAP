import { describe, expect, it } from "vitest";
import { computeFunnelMetrics, summarizeProviderUsage, type FunnelCounts } from "./metrics";

function counts(overrides: Partial<FunnelCounts> = {}): FunnelCounts {
  return {
    discoveryProviderCalls: 100,
    rawCandidates: 500,
    uniqueCandidates: 400,
    enrichmentAttempts: 400,
    enrichmentSuccesses: 300,
    emailsSearched: 400,
    emailsFound: 250,
    verificationAttempts: 250,
    verificationSuccesses: 200,
    processedCandidates: 400,
    readyCandidates: 150,
    queuedSends: 150,
    sentMessages: 140,
    bouncedMessages: 7,
    repliedMessages: 21,
    meetingsBooked: 3,
    ...overrides,
  };
}

describe("computeFunnelMetrics", () => {
  it("computes every §6.2 funnel rate correctly", () => {
    const metrics = computeFunnelMetrics(counts());
    expect(metrics.discoveryCalls).toBe(100);
    expect(metrics.rawYield).toBe(500);
    expect(metrics.uniqueYield).toBe(400);
    expect(metrics.enrichmentSuccessRate).toBeCloseTo(0.75);
    expect(metrics.emailFindRate).toBeCloseTo(0.625);
    expect(metrics.verificationSuccessRate).toBeCloseTo(0.8);
    expect(metrics.readyRate).toBeCloseTo(0.375);
    expect(metrics.sendRate).toBeCloseTo(140 / 150);
    expect(metrics.bounceRate).toBeCloseTo(7 / 140);
    expect(metrics.replyRate).toBeCloseTo(21 / 140);
    expect(metrics.meetingRate).toBeCloseTo(3 / 21);
  });

  it("never divides by zero — every rate is 0 when its denominator is 0", () => {
    const metrics = computeFunnelMetrics(
      counts({
        enrichmentAttempts: 0,
        emailsSearched: 0,
        verificationAttempts: 0,
        processedCandidates: 0,
        queuedSends: 0,
        sentMessages: 0,
        repliedMessages: 0,
      }),
    );
    expect(metrics.enrichmentSuccessRate).toBe(0);
    expect(metrics.emailFindRate).toBe(0);
    expect(metrics.verificationSuccessRate).toBe(0);
    expect(metrics.readyRate).toBe(0);
    expect(metrics.sendRate).toBe(0);
    expect(metrics.bounceRate).toBe(0);
    expect(metrics.replyRate).toBe(0);
    expect(metrics.meetingRate).toBe(0);
  });
});

describe("summarizeProviderUsage", () => {
  it("computes error rate and average latency per provider", () => {
    const summary = summarizeProviderUsage({
      maps: { calls: 100, errors: 5, totalLatencyMs: 20000, costUsd: 12.5 },
      email_verification: { calls: 0, errors: 0, totalLatencyMs: 0, costUsd: 0 },
    });
    const maps = summary.find((s) => s.provider === "maps")!;
    expect(maps.errorRate).toBeCloseTo(0.05);
    expect(maps.avgLatencyMs).toBe(200);
    const verification = summary.find((s) => s.provider === "email_verification")!;
    expect(verification.errorRate).toBe(0);
    expect(verification.avgLatencyMs).toBe(0);
  });
});
