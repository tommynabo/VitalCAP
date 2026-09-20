import { describe, expect, it } from "vitest";
import type { JobRecord } from "@/domain/discovery/types";
import { claimNextJob, completeJob, computeBackoffMs, failJob, isPermanentError } from "./job-queue";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
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

describe("claimNextJob", () => {
  it("claims a pending, due job", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob();
    const claimed = claimNextJob([job], "worker_a", now);
    expect(claimed?.status).toBe("processing");
    expect(claimed?.lockedBy).toBe("worker_a");
    expect(claimed?.attemptCount).toBe(1);
  });

  it("does not claim a job whose lease is still held by another worker", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ status: "processing", lockedAt: "2025-01-01T00:59:00Z", lockedBy: "worker_b" });
    const claimed = claimNextJob([job], "worker_a", now, { leaseMs: 5 * 60 * 1000 });
    expect(claimed).toBeNull();
  });

  it("reclaims a job whose lease has expired (crash recovery)", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ status: "processing", lockedAt: "2025-01-01T00:00:00Z", lockedBy: "worker_b" });
    const claimed = claimNextJob([job], "worker_a", now, { leaseMs: 5 * 60 * 1000 });
    expect(claimed?.lockedBy).toBe("worker_a");
  });

  it("never claims a job not yet due (nextAttemptAt in the future)", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ nextAttemptAt: "2025-01-01T02:00:00Z" });
    expect(claimNextJob([job], "worker_a", now)).toBeNull();
  });

  it("never claims a completed, failed, or dead-letter job", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    expect(claimNextJob([makeJob({ status: "completed" })], "w", now)).toBeNull();
    expect(claimNextJob([makeJob({ status: "dead_letter" })], "w", now)).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  it("doubles with each attempt and caps at the maximum", () => {
    expect(computeBackoffMs(1, 1000, 100_000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 100_000)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 100_000)).toBe(4000);
    expect(computeBackoffMs(20, 1000, 100_000)).toBe(100_000);
  });
});

describe("isPermanentError", () => {
  it("classifies validation-shaped errors as permanent", () => {
    expect(isPermanentError(new Error("Invalid payload: missing field"))).toBe(true);
    expect(isPermanentError(new Error("Unauthorized"))).toBe(true);
  });

  it("classifies a generic/transient error as non-permanent", () => {
    expect(isPermanentError(new Error("Connection timed out"))).toBe(false);
  });
});

describe("failJob", () => {
  it("retries a transient error with exponential backoff while under maxAttempts", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ attemptCount: 1, maxAttempts: 5 });
    const failed = failJob(job, new Error("Connection timed out"), now);
    expect(failed.status).toBe("pending");
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(failed.lastError).toContain("timed out");
  });

  it("dead-letters once maxAttempts is reached", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ attemptCount: 5, maxAttempts: 5 });
    const failed = failJob(job, new Error("Connection timed out"), now);
    expect(failed.status).toBe("dead_letter");
  });

  it("dead-letters a permanent error immediately regardless of attempt count", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ attemptCount: 1, maxAttempts: 5 });
    const failed = failJob(job, new Error("Invalid payload"), now);
    expect(failed.status).toBe("dead_letter");
  });
});

describe("completeJob", () => {
  it("clears the lock and marks completed", () => {
    const now = new Date("2025-01-01T01:00:00Z");
    const job = makeJob({ status: "processing", lockedAt: now.toISOString(), lockedBy: "worker_a" });
    const completed = completeJob(job, now);
    expect(completed.status).toBe("completed");
    expect(completed.lockedBy).toBeNull();
  });
});
