import { describe, expect, it } from "vitest";
import { computePacing, madridHourOf } from "./pacing-service";

describe("madridHourOf", () => {
  it("extracts the Europe/Madrid local hour from a UTC instant", () => {
    // 2025-06-15T10:00:00Z is 12:00 CEST (summer, UTC+2) in Madrid.
    expect(madridHourOf(new Date("2025-06-15T10:00:00Z"))).toBe(12);
  });
});

describe("computePacing", () => {
  const window = { startHour: 8, endHour: 20 };

  it("reports on_track when actual matches the linear trajectory", () => {
    // Midday (14:00 Madrid, summer) = 50% through an 8-20 window.
    const result = computePacing(250, 125, new Date("2025-06-15T12:00:00Z"), window);
    expect(result.status).toBe("on_track");
    expect(result.suggestedBatchMultiplier).toBe(1);
  });

  it("reports behind and suggests a >1 batch multiplier when trailing the trajectory", () => {
    const result = computePacing(250, 50, new Date("2025-06-15T12:00:00Z"), window);
    expect(result.status).toBe("behind");
    expect(result.suggestedBatchMultiplier).toBeGreaterThan(1);
  });

  it("reports ahead and suggests a <1 batch multiplier when far ahead of the trajectory", () => {
    const result = computePacing(250, 200, new Date("2025-06-15T12:00:00Z"), window);
    expect(result.status).toBe("ahead");
    expect(result.suggestedBatchMultiplier).toBeLessThan(1);
  });

  it("treats a moment before the window opens as zero expected progress (never behind before the day starts)", () => {
    const result = computePacing(250, 0, new Date("2025-06-15T05:00:00Z"), window);
    expect(result.expectedReadyByNow).toBe(0);
    expect(result.status).toBe("on_track");
  });
});
