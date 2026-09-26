import { getAuth } from "@/lib/auth/server";
import { isDevSeedMode } from "@/lib/config/env";
import { getOrCreateWorkspaceIdForUser, getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";

const DEV_SEED_WORKSPACE_ID = "ws_demo";

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "UnauthorizedError";
  }
}

export interface CurrentUser {
  userId: string;
  email: string | null;
  name: string | null;
}

export type WorkspaceRole = "member" | "admin" | "owner";

export interface AuthorizedWorkspaceContext {
  user: CurrentUser;
  workspaceId: string;
  role: WorkspaceRole;
}

/** Throws `UnauthorizedError` if there is no valid Neon Auth session. */
export async function requireCurrentUser(): Promise<CurrentUser> {
  const { data } = await getAuth().getSession();
  if (!data?.user) throw new UnauthorizedError();
  return { userId: data.user.id, email: data.user.email ?? null, name: data.user.name ?? null };
}

/**
 * Resolves the workspace id that repository queries should scope to.
 *
 * - Dev-seed mode: always the fixed demo workspace id, no auth/DB involved.
 * - Real mode: the signed-in user's workspace, auto-provisioning one on
 *   a brand-new user's first request (no manual onboarding step required).
 */
export async function getCurrentWorkspaceId(): Promise<string> {
  if (isDevSeedMode()) return DEV_SEED_WORKSPACE_ID;
  const user = await requireCurrentUser();
  return getOrCreateWorkspaceIdForUser(user.userId, user.name ?? user.email ?? "Workspace");
}

async function requireWorkspaceRole(allowed: WorkspaceRole[]): Promise<AuthorizedWorkspaceContext> {
  if (isDevSeedMode()) {
    return { user: { userId: "dev-seed-user", email: null, name: "Dev seed" }, workspaceId: DEV_SEED_WORKSPACE_ID, role: "owner" };
  }
  const user = await requireCurrentUser();
  const workspaceId = await getCurrentWorkspaceId();
  const role = (await getWorkspaceRole(workspaceId, user.userId)) as WorkspaceRole | null;
  if (!role || !allowed.includes(role)) throw new UnauthorizedError();
  return { user, workspaceId, role };
}

export function requireWorkspaceMember(): Promise<AuthorizedWorkspaceContext> {
  return requireWorkspaceRole(["member", "admin", "owner"]);
}

export function requireWorkspaceAdmin(): Promise<AuthorizedWorkspaceContext> {
  return requireWorkspaceRole(["admin", "owner"]);
}

export function requireWorkspaceOwner(): Promise<AuthorizedWorkspaceContext> {
  return requireWorkspaceRole(["owner"]);
}
