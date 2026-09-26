import { describe, expect, it } from "vitest";
import { getEffectiveAutopilotState } from "./types";
import { autopilotControlSchema } from "./control";

describe("Autopilot control plane", () => {
  it("treats missing/default settings as paused", () => {
    expect(getEffectiveAutopilotState({ enabled: false, emergencyStopped: false })).toBe("paused");
  });

  it("gives emergency stop precedence over enabled", () => {
    expect(getEffectiveAutopilotState({ enabled: true, emergencyStopped: true })).toBe("emergency_stopped");
  });

  it("requires clearing emergency stop before returning to running", () => {
    expect(getEffectiveAutopilotState({ enabled: false, emergencyStopped: false })).toBe("paused");
    expect(getEffectiveAutopilotState({ enabled: true, emergencyStopped: false })).toBe("running");
  });

  it("accepts the safe daily target range and rejects invalid values", () => {
    expect(autopilotControlSchema.parse({ action: "target_change", globalDailyTarget: 25 })).toEqual({ action: "target_change", globalDailyTarget: 25 });
    expect(autopilotControlSchema.safeParse({ action: "target_change", globalDailyTarget: 0 }).success).toBe(false);
    expect(autopilotControlSchema.safeParse({ action: "target_change", globalDailyTarget: 251 }).success).toBe(false);
    expect(autopilotControlSchema.safeParse({ action: "target_change", globalDailyTarget: 25.5 }).success).toBe(false);
  });

  it("keeps workspace state independent by evaluating each settings row separately", () => {
    const workspaceA = getEffectiveAutopilotState({ enabled: false, emergencyStopped: false });
    const workspaceB = getEffectiveAutopilotState({ enabled: true, emergencyStopped: false });
    expect(workspaceA).toBe("paused");
    expect(workspaceB).toBe("running");
  });
});
