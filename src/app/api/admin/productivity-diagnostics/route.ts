import { NextResponse } from "next/server";
import { UnauthorizedError, requireWorkspaceOwner } from "@/lib/auth/workspace";
import { getProductivityDiagnostics } from "@/infrastructure/neon/repositories/productivity-diagnostics";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const context = await requireWorkspaceOwner();
    const diagnostics = await getProductivityDiagnostics(context.workspaceId);
    return NextResponse.json(diagnostics, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Productivity diagnostics unavailable." }, { status: 500 });
  }
}