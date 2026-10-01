import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { campaigns, campaignMemberships } from "../schema/campaigns";
import type { Campaign, CampaignMembership, CampaignMembershipStage } from "@/domain/campaigns/types";

export interface CreateCampaignInput {
  workspaceId: string;
  offerId: string;
  name: string;
  description?: string | null;
  status: Campaign["status"];
  engineType: Campaign["engineType"];
  engineConfig: Campaign["engineConfig"];
  dailySoftTarget: number;
  autopilotEnabled: boolean;
  desiredChannelMix: Campaign["desiredChannelMix"];
}

export interface UpdateCampaignInput {
  workspaceId: string;
  campaignId: string;
  patch: Pick<Partial<Campaign>, "status" | "autopilotEnabled" | "dailySoftTarget">;
}

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
    qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
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

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const db = getDb();
  const [row] = await db
    .insert(campaigns)
    .values({
      workspaceId: input.workspaceId,
      offerId: input.offerId,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      countryCode: "ES",
      engineType: input.engineType,
      engineConfig: input.engineConfig,
      dailySoftTarget: input.dailySoftTarget,
      autopilotEnabled: input.autopilotEnabled,
      desiredChannelMix: input.desiredChannelMix,
      timeZone: "Europe/Madrid",
    })
    .returning();
  if (!row) throw new Error("Failed to create campaign.");
  return toCampaign(row);
}

/**
 * Updates only the dashboard-operable settings and scopes the mutation by
 * workspace. A campaign ID from another workspace therefore cannot be read
 * or changed through this repository.
 */
export async function updateCampaign(input: UpdateCampaignInput): Promise<Campaign | null> {
  const db = getDb();
  const values: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };
  if (input.patch.status !== undefined) values.status = input.patch.status;
  if (input.patch.autopilotEnabled !== undefined) values.autopilotEnabled = input.patch.autopilotEnabled;
  if (input.patch.dailySoftTarget !== undefined) values.dailySoftTarget = input.patch.dailySoftTarget;

  const [row] = await db
    .update(campaigns)
    .set(values)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.workspaceId, input.workspaceId)))
    .returning();
  return row ? toCampaign(row) : null;
}

/** Scheduled discovery only sees campaigns that are both active and explicitly autopilot-enabled. */
export async function listActiveCampaigns(workspaceId: string): Promise<Campaign[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active"), eq(campaigns.autopilotEnabled, true)));
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
  
  const isQualifiedOrLater = ["qualified", "contact_selected", "ready", "contacted"].includes(input.stage);
  
  await db.execute(sql`
    INSERT INTO campaign_memberships (
      campaign_id, account_id, contact_id, selected_contact_point_id,
      stage, rejection_reason, ready_at, qualified_at, created_at, updated_at
    )
    VALUES (
      ${input.campaignId}::uuid, ${input.accountId}::uuid, ${input.contactId ?? null}::uuid, ${input.selectedContactPointId ?? null}::uuid,
      ${input.stage}, ${input.rejectionReason ?? null}, ${input.readyAt ? input.readyAt.toISOString() : null}::timestamptz,
      CASE WHEN ${isQualifiedOrLater} THEN NOW() ELSE NULL END, NOW(), NOW()
    )
    ON CONFLICT (campaign_id, account_id) DO UPDATE SET
      stage = CASE
        WHEN campaign_memberships.stage = 'contacted' AND ${input.stage} IN ('qualified', 'contact_selected', 'ready') THEN campaign_memberships.stage
        WHEN campaign_memberships.stage = 'ready' AND ${input.stage} IN ('qualified', 'contact_selected') THEN campaign_memberships.stage
        WHEN campaign_memberships.stage = 'contact_selected' AND ${input.stage} = 'qualified' THEN campaign_memberships.stage
        ELSE ${input.stage}
      END,
      contact_id = coalesce(EXCLUDED.contact_id, campaign_memberships.contact_id),
      selected_contact_point_id = coalesce(EXCLUDED.selected_contact_point_id, campaign_memberships.selected_contact_point_id),
      ready_at = coalesce(EXCLUDED.ready_at, campaign_memberships.ready_at),
      rejection_reason = CASE WHEN ${input.stage} = 'rejected' THEN EXCLUDED.rejection_reason ELSE campaign_memberships.rejection_reason END,
      qualified_at = CASE
        WHEN campaign_memberships.qualified_at IS NOT NULL THEN campaign_memberships.qualified_at
        WHEN ${isQualifiedOrLater} THEN NOW()
        ELSE NULL
      END,
      updated_at = NOW()
  `);
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
