import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createCampaignSchema } from "@/domain/campaigns/create";
import { updateCampaignSchema } from "@/domain/campaigns/update";
import { createCampaign, updateCampaign } from "@/infrastructure/neon/repositories/campaigns";
import { getOfferById, getOrCreatePrimaryOffer } from "@/infrastructure/neon/repositories/offers";
import { UnauthorizedError, requireWorkspaceAdmin } from "@/lib/auth/workspace";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const command = createCampaignSchema.parse(await request.json());
    const context = await requireWorkspaceAdmin();
    const offer = command.offerId
      ? await getOfferById(context.workspaceId, command.offerId)
      : await getOrCreatePrimaryOffer(context.workspaceId);
    if (!offer) {
      return NextResponse.json({ error: "The selected offer is not available in this workspace." }, { status: 409 });
    }

    const campaign = await createCampaign({
      workspaceId: context.workspaceId,
      offerId: offer.id,
      name: command.name,
      description: command.description,
      status: command.status,
      engineType: command.engineType,
      engineConfig: command.engineConfig,
      dailySoftTarget: command.dailySoftTarget,
      autopilotEnabled: command.autopilotEnabled,
      desiredChannelMix: command.desiredChannelMix,
    });
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: "Invalid campaign data." }, { status: 400 });
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace authorization required." }, { status: 403 });
    return NextResponse.json({ error: "Campaign creation failed." }, { status: 500 });
  }
}

/**
 * Dashboard-only campaign control surface. The repository scopes the write
 * to the authenticated workspace, so an ID from another workspace is never
 * mutable by this endpoint.
 */
export async function PATCH(request: Request) {
  try {
    const command = updateCampaignSchema.parse(await request.json());
    const context = await requireWorkspaceAdmin();
    const campaign = await updateCampaign({
      workspaceId: context.workspaceId,
      campaignId: command.id,
      patch: {
        status: command.status,
        autopilotEnabled: command.autopilotEnabled,
        dailySoftTarget: command.dailySoftTarget,
      },
    });
    if (!campaign) return NextResponse.json({ error: "Campaign not found in this workspace." }, { status: 404 });
    return NextResponse.json({ campaign });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: "Invalid campaign update." }, { status: 400 });
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace authorization required." }, { status: 403 });
    return NextResponse.json({ error: "Campaign update failed." }, { status: 500 });
  }
}
