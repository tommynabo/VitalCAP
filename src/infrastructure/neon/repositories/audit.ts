import { getDb } from "../db";
import { auditLog } from "../schema/audit";

export async function insertAuditLog(input: {
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}