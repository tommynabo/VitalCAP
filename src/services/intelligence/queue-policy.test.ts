import { describe, expect, it } from "vitest";
import {
  deferExhaustedBudget,
  deferUnavailableProvider,
  retryFailedJob,
} from "./queue-policy";

describe("intelligence queue policy", () => {
  it("defers provider outages without consuming a retry", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const deferred = deferUnavailableProvider(3, now);

    expect(deferred.status).toBe("pending");
    expect(deferred.attemptCount).toBe(2);
    expect(deferred.nextAttemptAt.toISOString()).toBe("2026-10-03T12:15:00.000Z");
  });

  it("defers exhausted budget until its next window without consuming a retry", () => {
    const nextWindow = new Date("2026-10-04T00:00:00.000Z");
    const deferred = deferExhaustedBudget(4, nextWindow);

    expect(deferred.status).toBe("budget_paused");
    expect(deferred.attemptCount).toBe(3);
    expect(deferred.nextAttemptAt).toBe(nextWindow);
  });

  it("retries provider errors and dead-letters only after the configured limit", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");

    expect(retryFailedJob(2, 5, now)).toEqual({
      status: "failed",
      nextAttemptAt: new Date("2026-10-03T12:04:00.000Z"),
    });
    expect(retryFailedJob(5, 5, now)).toEqual({ status: "dead_letter", nextAttemptAt: null });
  });
});