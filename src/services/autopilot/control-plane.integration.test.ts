import { beforeEach, describe, expect, it, vi } from "vitest";

const updateAutopilotSettingsWithAudit = vi.fn();
const getAutopilotSettings = vi.fn();
const requireWorkspaceAdmin = vi.fn();

vi.mock("@/infrastructure/neon/repositories/autopilot", () => ({
  getAutopilotSettings,
  updateAutopilotSettingsWithAudit,
}));
vi.mock("@/lib/auth/workspace", () => ({ requireWorkspaceAdmin }));

const { executeAutopilotControl } = await import("./control-plane");

const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorUserId = "user_1";

function settings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    workspaceId,
    enabled: false,
    emergencyStopped: false,
    systemPaused: false,
    systemPauseReason: null,
    systemPausedAt: null,
    globalDailyTarget: 25,
    targetMetric: "qualified",
    timezone: "Europe/Madrid",
    operatingStartHour: null,
    operatingEndHour: null,
    maxDailyApifySpendUsd: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("Autopilot controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceAdmin.mockResolvedValue({ workspaceId, user: { userId: actorUserId } });
    getAutopilotSettings.mockResolvedValue(settings());
    updateAutopilotSettingsWithAudit.mockImplementation(async ({ patch }) => settings(patch));
  });

  it.each([
    ["target_change", { action: "target_change", globalDailyTarget: 250 }, { globalDailyTarget: 250 }],
    ["resume", { action: "resume" }, { enabled: true }],
    ["pause", { action: "pause" }, { enabled: false }],
    ["emergency_stop", { action: "emergency_stop" }, { enabled: false, emergencyStopped: true }],
    ["clear_emergency_stop", { action: "clear_emergency_stop" }, { enabled: false, emergencyStopped: false }],
  ])("persists %s and returns the complete settings shape", async (_name, command, expectedPatch) => {
    const result = await executeAutopilotControl(command);

    expect(updateAutopilotSettingsWithAudit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, patch: expectedPatch }));
    expect(result).toEqual(expect.objectContaining({
      workspaceId,
      enabled: expect.any(Boolean),
      emergencyStopped: expect.any(Boolean),
      systemPaused: expect.any(Boolean),
      globalDailyTarget: expect.any(Number),
      targetMetric: "qualified",
      timezone: "Europe/Madrid",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    }));
  });
});
