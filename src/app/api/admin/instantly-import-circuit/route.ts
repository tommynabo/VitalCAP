import { NextResponse } from "next/server";
import {
  getInstantlyImportCircuitState,
  resetInstantlyImportCircuit,
} from "@/infrastructure/neon/repositories/instantly-lead-imports";
import { UnauthorizedError, requireWorkspaceOwner } from "@/lib/auth/workspace";
import { getDeliveryEnv, isDevSeedMode } from "@/lib/config/env";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isDevSeedMode()) {
    return NextResponse.json({ error: "Instantly circuit controls are unavailable in seed mode." }, { status: 409 });
  }
  try {
    const context = await requireWorkspaceOwner();
    const { INSTANTLY_CAMPAIGN_ID } = getDeliveryEnv();
    const circuit = await getInstantlyImportCircuitState(INSTANTLY_CAMPAIGN_ID, context.workspaceId);
    return NextResponse.json({ circuit }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Instantly circuit state unavailable." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (isDevSeedMode()) {
    return NextResponse.json({ error: "Instantly circuit controls are unavailable in seed mode." }, { status: 409 });
  }
  try {
    const context = await requireWorkspaceOwner();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Confirmation is required." }, { status: 400 });
    }
    if (body === null || typeof body !== "object" || (body as { confirm?: unknown }).confirm !== true) {
      return NextResponse.json({ error: "Pass confirm=true to reset an authentication circuit." }, { status: 400 });
    }

    const { INSTANTLY_CAMPAIGN_ID } = getDeliveryEnv();
    const result = await resetInstantlyImportCircuit({
      providerCampaignId: INSTANTLY_CAMPAIGN_ID,
      workspaceId: context.workspaceId,
      actorUserId: context.user.userId,
    });
    return NextResponse.json({ ...result, circuit: await getInstantlyImportCircuitState(INSTANTLY_CAMPAIGN_ID, context.workspaceId) });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Workspace owner authorization required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Instantly circuit reset failed." }, { status: 500 });
  }
}