import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { campaigns } from "../schema/campaigns";
import type { Campaign } from "@/domain/campaigns/types";

function toCampaign(row: typeof campaigns.$inferSelect): Campaign {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    offerId: row.offerId,
    name: row.name,
    description: row.description,
    status: row.status as Campaign["status"],
    countryCode: "ES",
    engineType: row.engineType as Campaign["engineType"],
    engineConfig: row.engineConfig as Campaign["engineConfig"],
    dailySoftTarget: row.dailySoftTarget,
    minimumFitScore: row.minimumFitScore,
    outreachProfileId: row.outreachProfileId,
    autopilotEnabled: row.autopilotEnabled,
    desiredChannelMix: row.desiredChannelMix as Campaign["desiredChannelMix"],
    timeZone: row.timeZone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCampaigns(workspaceId: string): Promise<Campaign[]> {
  const db = getDb();
  const rows = await db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId));
  return rows.map(toCampaign);
}
