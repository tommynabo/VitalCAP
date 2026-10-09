import { describe, expect, it } from "vitest";
import { getDayBounds } from "./day-bounds";

describe("getDayBounds", () => {
  it("uses the campaign timezone rather than UTC", () => {
    const bounds = getDayBounds("Europe/Madrid", new Date("2026-01-01T23:30:00.000Z"));
    expect(bounds.start.toISOString()).toBe("2026-01-01T23:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-01-02T23:00:00.000Z");
  });

  it("handles a DST boundary", () => {
    const bounds = getDayBounds("Europe/Madrid", new Date("2026-03-29T12:00:00.000Z"));
    expect(bounds.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("uses the full 25-hour Madrid day when daylight saving time ends", () => {
    const bounds = getDayBounds("Europe/Madrid", new Date("2025-10-26T12:00:00.000Z"));
    expect(bounds.start.toISOString()).toBe("2025-10-25T22:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2025-10-26T23:00:00.000Z");
  });
});
