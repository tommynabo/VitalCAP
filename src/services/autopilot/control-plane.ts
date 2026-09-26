import { getAutopilotSettings, updateAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { insertAuditLog } from "@/infrastructure/neon/repositories/audit";
import { requireWorkspaceAdmin } from "@/lib/auth/workspace";
import { autopilotControlSchema } from "@/domain/autopilot/control";

export async function executeAutopilotControl(input: unknown) {
  const command = autopilotControlSchema.parse(input);
  const context = await requireWorkspaceAdmin();
  const before = await getAutopilotSettings(context.workspaceId);
  let after = before;
  let action: string;

  if (command.action === "pause") {
    after = await updateAutopilotSettings(context.workspaceId, { enabled: false });
    action = "autopilot_pause";
  } else if (command.action === "resume") {
    if (before.emergencyStopped) throw new Error("Clear the emergency stop before resuming Autopilot.");
    after = await updateAutopilotSettings(context.workspaceId, { enabled: true });
    action = "autopilot_resume";
  } else if (command.action === "emergency_stop") {
    after = await updateAutopilotSettings(context.workspaceId, { enabled: false, emergencyStopped: true });
    action = "autopilot_emergency_stop";
  } else if (command.action === "clear_emergency_stop") {
    after = await updateAutopilotSettings(context.workspaceId, { enabled: false, emergencyStopped: false });
    action = "autopilot_clear_emergency_stop";
  } else {
    after = await updateAutopilotSettings(context.workspaceId, { globalDailyTarget: command.globalDailyTarget });
    action = "autopilot_target_change";
  }

  await insertAuditLog({
    workspaceId: context.workspaceId,
    actorUserId: context.user.userId,
    action,
    entityType: "autopilot_settings",
    entityId: context.workspaceId,
    metadata: {
      old: { enabled: before.enabled, emergencyStopped: before.emergencyStopped, globalDailyTarget: before.globalDailyTarget },
      new: { enabled: after.enabled, emergencyStopped: after.emergencyStopped, globalDailyTarget: after.globalDailyTarget },
    },
  });
  return after;
}