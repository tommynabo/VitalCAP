import { describe, expect, it } from "vitest";
import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import { summarizeEngineHealthStatuses } from "@/services/discovery/provider-health";
import { computeNavBadgeCounts } from "./nav-badges";

describe("navigation badge engine-health summary", () => {
  it("preserves the previous degraded-or-paused badge count", () => {
    const previousEngineHealth: ProviderHealthStatus[] = ["degraded", "paused", "healthy", "untested", "unknown"];
    const expected = previousEngineHealth.filter((status) => status === "degraded" || status === "paused").length;
    const engineHealthSummary = summarizeEngineHealthStatuses(previousEngineHealth);

    const badgeCounts = computeNavBadgeCounts({
      conversations: [],
      engineHealthSummary,
      sendingDomains: [],
      mailboxes: [],
    });

    expect(badgeCounts["/autopilot"]).toBe(expected);
  });
});