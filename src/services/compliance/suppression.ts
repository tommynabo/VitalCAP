import { getDb, schema } from "@/infrastructure/neon/db";
import { and, eq, or, sql } from "drizzle-orm";

export interface SuppressionTarget {
  accountId?: string;
  contactPointId?: string;
}

export async function addSuppression(
  workspaceId: string,
  target: SuppressionTarget,
  reason: string
): Promise<void> {
  const db = getDb();
  
  // Check if it already exists to make it idempotent
  const conditions = [eq(schema.suppressionEntries.workspaceId, workspaceId)];
  if (target.accountId) {
    conditions.push(eq(schema.suppressionEntries.accountId, target.accountId));
  } else {
    conditions.push(sql`account_id IS NULL`);
  }
  if (target.contactPointId) {
    conditions.push(eq(schema.suppressionEntries.contactPointId, target.contactPointId));
  } else {
    conditions.push(sql`contact_point_id IS NULL`);
  }

  const existing = await db
    .select({ id: schema.suppressionEntries.id })
    .from(schema.suppressionEntries)
    .where(and(...conditions))
    .limit(1);

  if (existing.length > 0) return;

  await db.insert(schema.suppressionEntries).values({
    workspaceId,
    accountId: target.accountId || null,
    contactPointId: target.contactPointId || null,
    reason,
  });
}

export async function checkSuppression(
  workspaceId: string,
  target: SuppressionTarget
): Promise<boolean> {
  const db = getDb();
  
  const conditions = [eq(schema.suppressionEntries.workspaceId, workspaceId)];
  
  const targetOr = [];
  if (target.accountId) {
    targetOr.push(eq(schema.suppressionEntries.accountId, target.accountId));
  }
  if (target.contactPointId) {
    targetOr.push(eq(schema.suppressionEntries.contactPointId, target.contactPointId));
  }
  
  if (targetOr.length === 0) return false;
  
  conditions.push(or(...targetOr)!);

  const existing = await db
    .select({ id: schema.suppressionEntries.id })
    .from(schema.suppressionEntries)
    .where(and(...conditions))
    .limit(1);

  return existing.length > 0;
}
