import { sql } from "drizzle-orm";
import { getDb } from "../db";

export interface MultiNicheCampaignInventory {
  campaignId: string;
  rawRequestedToday: number;
  backlogInventory: number;
  confirmedImports: number;
  completedProbeCount: number;
}

export async function getMultiNicheCampaignInventory(
  campaignIds: readonly string[],
  dayStart: Date,
  dayEnd: Date,
  now = new Date(),
): Promise<MultiNicheCampaignInventory[]> {
  if (campaignIds.length === 0) return [];
  const campaignIdList = sql.join(campaignIds.map((campaignId) => sql`${campaignId}::uuid`), sql`, `);
  const result = await getDb().execute(sql`
    SELECT c.id AS campaign_id,
      (
        SELECT COALESCE(SUM(pr.items_requested), 0)::int
        FROM provider_runs pr
        WHERE pr.campaign_id = c.id
          AND pr.provider IN ('apify', 'serper')
          AND pr.started_at >= ${dayStart.toISOString()}::timestamptz
          AND pr.started_at < ${dayEnd.toISOString()}::timestamptz
      ) AS raw_requested_today,
      (
        SELECT COUNT(*)::int
        FROM raw_candidates rc
        WHERE rc.campaign_id = c.id AND rc.processed = false
      ) + (
        SELECT COUNT(*)::int
        FROM discovery_jobs dj
        WHERE dj.campaign_id = c.id AND dj.status IN ('pending', 'processing')
      ) + (
        SELECT COUNT(*)::int
        FROM processing_jobs pj
        WHERE pj.campaign_id = c.id AND pj.status IN ('pending', 'processing')
      ) + (
        SELECT COUNT(DISTINCT vj.id)::int
        FROM verification_jobs vj
        JOIN contact_points cp ON cp.id = vj.contact_point_id
        JOIN campaign_memberships cm ON cm.account_id = cp.account_id AND cm.campaign_id = c.id
        WHERE vj.workspace_id = c.workspace_id AND vj.status IN ('pending', 'processing')
      ) + (
        SELECT COUNT(DISTINCT cm.account_id)::int
        FROM campaign_memberships cm
        WHERE cm.campaign_id = c.id AND cm.stage IN ('qualified', 'contact_selected', 'ready')
      ) AS backlog_inventory,
      (
        SELECT COUNT(DISTINCT ili.account_id)::int
        FROM instantly_lead_imports ili
        WHERE ili.source_campaign_id = c.id
          AND ili.status = 'instantly_added'
          AND ili.provider_lead_id IS NOT NULL
      ) AS confirmed_imports,
      (
        SELECT COUNT(*)::int
        FROM provider_runs pr
        WHERE pr.campaign_id = c.id
          AND pr.provider IN ('apify', 'serper')
          AND pr.status IN ('succeeded', 'ingested', 'completed')
          AND pr.started_at >= ${new Date(now.getTime() - 90 * 24 * 60 * 60_000).toISOString()}::timestamptz
      ) AS completed_probe_count
    FROM campaigns c
    WHERE c.id IN (${campaignIdList})
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    campaignId: String(row.campaign_id),
    rawRequestedToday: Number(row.raw_requested_today ?? 0),
    backlogInventory: Number(row.backlog_inventory ?? 0),
    confirmedImports: Number(row.confirmed_imports ?? 0),
    completedProbeCount: Number(row.completed_probe_count ?? 0),
  }));
}

export async function getScopedCampaignProviderSpend(campaignId: string, since: Date): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric AS total
    FROM provider_runs
    WHERE campaign_id = ${campaignId}::uuid
      AND provider IN ('apify', 'serper')
      AND started_at >= ${since.toISOString()}::timestamptz
  `);
  return Number((result.rows[0] as { total?: unknown } | undefined)?.total ?? 0);
}