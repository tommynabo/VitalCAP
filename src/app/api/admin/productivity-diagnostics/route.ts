import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { UnauthorizedError, requireWorkspaceOwner } from "@/lib/auth/workspace";
import {
  getProductivityDiagnostics,
  ProductivityDiagnosticsStageError,
} from "@/infrastructure/neon/repositories/productivity-diagnostics";
import { logEvent } from "@/lib/observability/structured-logger";

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
    const stageError = error instanceof ProductivityDiagnosticsStageError ? error : null;
    logEvent("error", "productivity_diagnostics_failed", {
      correlationId: randomUUID(),
      stage: stageError?.stage ?? "unknown",
      sqlState: stageError?.sqlState ?? null,
      errorClass: stageError?.errorClass ?? "Error",
    });
    return NextResponse.json({ error: "Productivity diagnostics unavailable." }, { status: 500 });
  }
}