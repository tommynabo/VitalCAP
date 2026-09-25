import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { campaigns, campaignMemberships } from "../schema/campaigns";
import type { Campaign, CampaignMembership, CampaignMembershipStage } from "@/domain/campaigns/types";

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

function toCampaignMembership(row: typeof campaignMemberships.$inferSelect): CampaignMembership {
  return {
    id: row.id,
    campaignId: row.campaignId,
    accountId: row.accountId,
    contactId: row.contactId,
    selectedContactPointId: row.selectedContactPointId,
    stage: row.stage as CampaignMembershipStage,
    rejectionReason: row.rejectionReason,
    readyAt: row.readyAt?.toISOString() ?? null,
    contactedAt: row.contactedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCampaigns(workspaceId: string): Promise<Campaign[]> {
  const db = getDb();
  const rows = await db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId));
  return rows.map(toCampaign);
}

export async function getCampaignById(campaignId: string): Promise<Campaign | null> {
  const db = getDb();
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  return row ? toCampaign(row) : null;
}

/** Every `status = 'active'` campaign, workspace-wide — the cron routes' outer loop (`listWorkspaceIds` × `listActiveCampaigns`). "Campaign pause prevents claims" (§24) applies identically here: a paused/draft/archived campaign is invisible to every cron. */
export async function listActiveCampaigns(workspaceId: string): Promise<Campaign[]> {
  const db = getDb();
  const rows = await db.select().from(campaigns).where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active")));
  return rows.map(toCampaign);
}

export async function listAutopilotEnabledCampaigns(workspaceId: string): Promise<Campaign[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active"), eq(campaigns.autopilotEnabled, true)));
  return rows.map(toCampaign);
}

export interface UpsertCampaignMembershipInput {
  campaignId: string;
  accountId: string;
  contactId?: string | null;
  selectedContactPointId?: string | null;
  stage: CampaignMembershipStage;
  rejectionReason?: string | null;
  readyAt?: Date | null;
}

/** Upserts on the existing `(campaign_id, account_id)` unique index — an account can only ever have one membership row per campaign, so re-processing the same account is idempotent. */
export async function upsertCampaignMembership(input: UpsertCampaignMembershipInput): Promise<void> {
  const db = getDb();
  const values = {
    campaignId: input.campaignId,
    accountId: input.accountId,
    contactId: input.contactId ?? null,
    selectedContactPointId: input.selectedContactPointId ?? null,
    stage: input.stage,
    rejectionReason: input.rejectionReason ?? null,
    readyAt: input.readyAt ?? null,
  };
  await db
    .insert(campaignMemberships)
    .values(values)
    .onConflictDoUpdate({
      target: [campaignMemberships.campaignId, campaignMemberships.accountId],
      set: { ...values, updatedAt: new Date() },
    });
}

export async function listCampaignMembershipsByStage(campaignId: string, stage: CampaignMembershipStage, limit: number): Promise<CampaignMembership[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignMemberships)
    .where(and(eq(campaignMemberships.campaignId, campaignId), eq(campaignMemberships.stage, stage)))
    .limit(limit);
  return rows.map(toCampaignMembership);
}
