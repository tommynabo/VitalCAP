import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createCampaignSchema } from "@/domain/campaigns/create";
import { createCampaign } from "@/infrastructure/neon/repositories/campaigns";
import { getOfferById, getPrimaryOffer } from "@/infrastructure/neon/repositories/offers";
import { UnauthorizedError, requireWorkspaceAdmin } from "@/lib/auth/workspace";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const command = createCampaignSchema.parse(await request.json());
    const context = await requireWorkspaceAdmin();
    const offer = command.offerId
      ? await getOfferById(context.workspaceId, command.offerId)
      : await getPrimaryOffer(context.workspaceId);
    if (!offer) {
      return NextResponse.json({ error: "Create or select an offer before creating a campaign." }, { status: 409 });
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
