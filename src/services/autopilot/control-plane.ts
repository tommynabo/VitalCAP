import { getAutopilotSettings, updateAutopilotSettingsWithAudit } from "@/infrastructure/neon/repositories/autopilot";
import { requireWorkspaceAdmin } from "@/lib/auth/workspace";
import { autopilotControlSchema } from "@/domain/autopilot/control";

export async function executeAutopilotControl(input: unknown) {
  const command = autopilotControlSchema.parse(input);
  const context = await requireWorkspaceAdmin();
  const before = await getAutopilotSettings(context.workspaceId);
  let patch: Parameters<typeof updateAutopilotSettingsWithAudit>[0]["patch"];
  let action: string;

  if (command.action === "pause") {
    patch = { enabled: false };
    action = "autopilot_pause";
  } else if (command.action === "resume") {
    if (before.emergencyStopped) throw new Error("Clear the emergency stop before resuming Autopilot.");
    patch = { enabled: true };
    action = "autopilot_resume";
  } else if (command.action === "emergency_stop") {
    patch = { enabled: false, emergencyStopped: true };
    action = "autopilot_emergency_stop";
  } else if (command.action === "clear_emergency_stop") {
    patch = { enabled: false, emergencyStopped: false };
    action = "autopilot_clear_emergency_stop";
  } else {
    patch = { globalDailyTarget: command.globalDailyTarget };
    action = "autopilot_target_change";
  }

  const after = await updateAutopilotSettingsWithAudit({
    workspaceId: context.workspaceId,
    patch,
    audit: { actorUserId: context.user.userId, action, metadata: {
      old: { enabled: before.enabled, emergencyStopped: before.emergencyStopped, globalDailyTarget: before.globalDailyTarget },
      new: { ...patch },
    } },
  });
  return after;
}