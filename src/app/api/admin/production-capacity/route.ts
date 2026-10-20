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
    const errorDetails = typeof error === "object" && error !== null
      ? error as Record<string, unknown>
      : {};
    const causeDetails = typeof errorDetails.cause === "object" && errorDetails.cause !== null
      ? errorDetails.cause as Record<string, unknown>
      : {};
    const sourceErrorDetails = typeof errorDetails.sourceError === "object" && errorDetails.sourceError !== null
      ? errorDetails.sourceError as Record<string, unknown>
      : typeof causeDetails.sourceError === "object" && causeDetails.sourceError !== null
        ? causeDetails.sourceError as Record<string, unknown>
        : {};
    const errorCode = [errorDetails.code, causeDetails.code, sourceErrorDetails.code]
      .find((code) => typeof code === "string" || typeof code === "number");
    const errorPosition = [errorDetails.position, causeDetails.position, sourceErrorDetails.position]
      .find((position) => typeof position === "string" || typeof position === "number");
    console.error("production_capacity_diagnostics_failed", {
      errorType: error instanceof Error ? error.name : typeof error,
      ...(typeof errorCode === "string" || typeof errorCode === "number" ? { errorCode } : {}),
      ...(typeof errorPosition === "string" || typeof errorPosition === "number" ? { errorPosition } : {}),
    });
    return NextResponse.json({ error: "Production capacity diagnostics unavailable." }, { status: 500 });
  }
}