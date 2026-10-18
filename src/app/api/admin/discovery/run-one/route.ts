import { NextResponse } from "next/server";
import { runDiscoveryCronTick } from "@/infrastructure/jobs/runners/discovery-runner";
import { getCurrentWorkspaceId, requireCurrentUser, UnauthorizedError } from "@/lib/auth/workspace";
import { getWorkspaceRole } from "@/infrastructure/neon/repositories/workspace";

export const dynamic = "force-dynamic";

export async function POST(_request: Request) {
  try {
    const user = await requireCurrentUser();
    const workspaceId = await getCurrentWorkspaceId();
    const role = await getWorkspaceRole(workspaceId, user.userId);
    if (role !== "admin" && role !== "owner") {
      return NextResponse.json({ error: "Workspace admin authorization required." }, { status: 403 });
    }

    const result = await runDiscoveryCronTick(1);
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    return NextResponse.json({ error: "Discovery tick failed." }, { status: 500 });
  }
}