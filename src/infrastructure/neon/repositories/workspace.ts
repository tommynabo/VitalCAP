import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { workspaces, workspaceMembers } from "../schema/workspaces";

/**
 * Workspace bootstrap/lookup. Neon Auth owns user identity; this module
 * only maps an authenticated user id to the workspace(s) they belong to,
 * and auto-provisions a first workspace on a brand-new user's first
 * session (no manual DB step required to use the app end to end).
 */
export async function findWorkspaceIdForUser(userId: string): Promise<string | null> {
  const db = getDb();
  const [membership] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  return membership?.workspaceId ?? null;
}

export async function createWorkspaceForUser(userId: string, workspaceName: string): Promise<string> {
  const db = getDb();
  const [workspace] = await db.insert(workspaces).values({ name: workspaceName }).returning({ id: workspaces.id });
  if (!workspace) throw new Error("Failed to create workspace.");
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId, role: "owner" });
  return workspace.id;
}

export async function getOrCreateWorkspaceIdForUser(userId: string, fallbackName: string): Promise<string> {
  const existing = await findWorkspaceIdForUser(userId);
  if (existing) return existing;
  return createWorkspaceForUser(userId, fallbackName);
}

/** Every workspace id (Gate E cron routes tick across all workspaces, not just the caller's). Bounded — see docs/PERFORMANCE_REVIEW.md if this ever needs pagination. */
export async function listWorkspaceIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: workspaces.id }).from(workspaces);
  return rows.map((row) => row.id);
}
