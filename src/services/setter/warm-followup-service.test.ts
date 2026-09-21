import { describe, expect, it } from "vitest";
import { applyWarmFollowupTrigger, enterWarmFollowupQueue, isDueForFollowup } from "./warm-followup-service";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

describe("enterWarmFollowupQueue", () => {
  it("enqueues an interested lead that has not booked a meeting", () => {
    const item = enterWarmFollowupQueue("conv-1", "INTEREST", false, "2024-01-01T00:00:00.000Z", nextId);
    expect(item?.status).toBe("active");
    expect(item?.nextFollowupAt).not.toBeNull();
  });

  it("does not enqueue a lead that already booked a meeting", () => {
    const item = enterWarmFollowupQueue("conv-1", "INTEREST", true, "2024-01-01T00:00:00.000Z", nextId);
    expect(item).toBeNull();
  });

  it("does not enqueue a branch that isn't warm-eligible", () => {
    const item = enterWarmFollowupQueue("conv-1", "NOT_INTERESTED", false, "2024-01-01T00:00:00.000Z", nextId);
    expect(item).toBeNull();
  });
});

describe("applyWarmFollowupTrigger", () => {
  const base = enterWarmFollowupQueue("conv-1", "INTEREST", false, "2024-01-01T00:00:00.000Z", nextId)!;

  it("pauses immediately on a new reply", () => {
    const result = applyWarmFollowupTrigger(base, "reply");
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("reply");
    expect(result.nextFollowupAt).toBeNull();
  });

  it("completes (not just pauses) when a meeting is booked", () => {
    const result = applyWarmFollowupTrigger(base, "meeting");
    expect(result.status).toBe("completed");
  });

  it("pauses on unsubscribe", () => {
    const result = applyWarmFollowupTrigger(base, "unsubscribe");
    expect(result.status).toBe("paused");
  });

  it("pauses on human ownership", () => {
    const result = applyWarmFollowupTrigger(base, "human_ownership");
    expect(result.status).toBe("paused");
  });
});

describe("isDueForFollowup", () => {
  it("is not due before the scheduled time", () => {
    const item = enterWarmFollowupQueue("conv-1", "INTEREST", false, "2024-01-01T00:00:00.000Z", nextId)!;
    expect(isDueForFollowup(item, new Date("2024-01-01T12:00:00.000Z"))).toBe(false);
  });

  it("is due after the scheduled delay elapses", () => {
    const item = enterWarmFollowupQueue("conv-1", "INTEREST", false, "2024-01-01T00:00:00.000Z", nextId)!;
    expect(isDueForFollowup(item, new Date("2024-01-05T00:00:00.000Z"))).toBe(true);
  });

  it("is never due once paused", () => {
    const item = enterWarmFollowupQueue("conv-1", "INTEREST", false, "2024-01-01T00:00:00.000Z", nextId)!;
    const paused = applyWarmFollowupTrigger(item, "reply");
    expect(isDueForFollowup(paused, new Date("2024-01-10T00:00:00.000Z"))).toBe(false);
  });
});
