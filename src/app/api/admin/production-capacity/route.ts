import { NextResponse } from "next/server";
import { UnauthorizedError, requireWorkspaceOwner } from "@/lib/auth/workspace";
import { getProductionCapacityDiagnostics } from "@/infrastructure/neon/repositories/production-capacity-diagnostics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireWorkspaceOwner();
    const cohortStartValue = new URL(request.url).searchParams.get("recoveryAttributionCohortStart");
    let cohortStart: Date | null = null;
    if (cohortStartValue !== null) {
      cohortStart = new Date(cohortStartValue);
      if (Number.isNaN(cohortStart.getTime()) || cohortStart > new Date()) {
        return NextResponse.json({ error: "Invalid recovery attribution cohort start." }, { status: 400 });
      }
    }
    const diagnostics = cohortStart
      ? await getProductionCapacityDiagnostics(context.workspaceId, new Date(), cohortStart)
      : await getProductionCapacityDiagnostics(context.workspaceId);
    return NextResponse.json(diagnostics, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Production capacity diagnostics unavailable." }, { status: 500 });
  }
}