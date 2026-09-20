import { describe, expect, it } from "vitest";
import type { JobRecord } from "@/domain/discovery/types";
import { evaluateQueueHealth } from "./queue-health-service";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    campaignId: "camp_1",
    type: "discovery",
    payload: {},
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("evaluateQueueHealth", () => {
  it("reports healthy for a small, fresh queue", () => {
    const now = new Date("2025-01-01T00:05:00Z");
    const snapshot = evaluateQueueHealth([job()], now);
    expect(snapshot.healthy).toBe(true);
    expect(snapshot.pendingCount).toBe(1);
  });

  it("flags jobs stuck in processing well past a reasonable lease", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const stuck = job({ status: "processing", lockedAt: "2025-01-01T00:00:00Z" });
    const snapshot = evaluateQueueHealth([stuck], now);
    expect(snapshot.stuckProcessingCount).toBe(1);
    expect(snapshot.healthy).toBe(false);
  });

  it("flags an old pending backlog as unhealthy", () => {
    const now = new Date("2025-01-01T02:00:00Z");
    const stale = job({ createdAt: "2025-01-01T00:00:00Z" });
    const snapshot = evaluateQueueHealth([stale], now, { maxHealthyOldestPendingMs: 60 * 60 * 1000 });
    expect(snapshot.healthy).toBe(false);
  });

  it("counts dead-letter jobs separately from pending/processing", () => {
    const now = new Date("2025-01-01T00:05:00Z");
    const snapshot = evaluateQueueHealth([job({ status: "dead_letter" }), job()], now);
    expect(snapshot.deadLetterCount).toBe(1);
    expect(snapshot.pendingCount).toBe(1);
  });
});
