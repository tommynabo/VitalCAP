import { describe, expect, it } from "vitest";
import { allowsDiscovery, allowsNewApifyRun, allowsOutreachScheduling, allowsProcessingClaim } from "./gates";

describe("Autopilot worker gates", () => {
  it("only allows new discovery and Apify runs while running", () => {
    expect(allowsDiscovery("running")).toBe(true);
    expect(allowsNewApifyRun("paused")).toBe(false);
    expect(allowsNewApifyRun("emergency_stopped")).toBe(false);
  });

  it("allows paused processing to drain but blocks emergency processing claims", () => {
    expect(allowsProcessingClaim("paused")).toBe(true);
    expect(allowsProcessingClaim("emergency_stopped")).toBe(false);
  });

  it("uses emergency stop as the outreach backstop", () => {
    expect(allowsOutreachScheduling("paused")).toBe(true);
    expect(allowsOutreachScheduling("emergency_stopped")).toBe(false);
  });
});