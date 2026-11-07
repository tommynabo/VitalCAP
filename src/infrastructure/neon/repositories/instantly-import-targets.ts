import { sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/neon/db";
import { getDeliveryEnv } from "@/lib/config/env";

export interface InstantImportTarget {
  campaignId: string;
  workspaceId: string;
  providerCampaignId: string;
  legacyFallback: boolean;
}

interface CampaignTargetRow {
  campaign_id: string;
  workspace_id: string;
  engine_config: unknown;
  mapping_campaign_id: string | null;
  mapping_enabled: boolean | null;
  mapped_provider_campaign_id: string | null;
}

export function resolveInstantlyImportTargets(
  rows: readonly CampaignTargetRow[],
  legacyProviderCampaignId: string,
): { targets: InstantImportTarget[]; blockedCampaignIds: string[] } {
  const candidates: InstantImportTarget[] = [];
  const blockedCampaignIds = new Set<string>();

  for (const row of rows) {
    const config = row.engine_config !== null && typeof row.engine_config === "object" && !Array.isArray(row.engine_config)
      ? row.engine_config as Record<string, unknown>
      : {};
    const hasNiche = Object.hasOwn(config, "niche");
    if (row.mapping_campaign_id && row.mapping_enabled !== true) {
      blockedCampaignIds.add(row.campaign_id);
      continue;
    }

    const configuredId = [row.mapped_provider_campaign_id, config.instantlyCampaignId, config.providerCampaignId]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    const legacyFallback = !configuredId && !hasNiche && Boolean(legacyProviderCampaignId.trim());
    const providerCampaignId = configuredId ?? (legacyFallback ? legacyProviderCampaignId.trim() : null);
    if (!providerCampaignId) {
      blockedCampaignIds.add(row.campaign_id);
      continue;
    }

    candidates.push({
      campaignId: row.campaign_id,
      workspaceId: row.workspace_id,
      providerCampaignId,
      legacyFallback,
    });
  }

  const groups = new Map<string, InstantImportTarget[]>();
  for (const target of candidates) {
    const key = `${target.workspaceId}:${target.providerCampaignId}`;
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }

  const targets: InstantImportTarget[] = [];
  for (const group of groups.values()) {
    const explicitTargets = group.filter((target) => !target.legacyFallback);
    if (explicitTargets.length > 0 && group.length > 1) {
      for (const target of explicitTargets) blockedCampaignIds.add(target.campaignId);
      targets.push(...group.filter((target) => target.legacyFallback));
      continue;
    }
    targets.push(...group);
  }

  return { targets, blockedCampaignIds: [...blockedCampaignIds] };
}

export async function listInstantlyImportTargets(): Promise<ReturnType<typeof resolveInstantlyImportTargets>> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT c.id AS campaign_id, c.workspace_id, c.engine_config,
      mapping.campaign_id AS mapping_campaign_id,
      mapping.enabled AS mapping_enabled,
      mapping.provider_campaign_id AS mapped_provider_campaign_id
    FROM campaigns c
    LEFT JOIN campaign_provider_mappings mapping
      ON mapping.campaign_id = c.id AND mapping.provider = 'instantly'
    WHERE c.status = 'active'
    ORDER BY c.workspace_id, c.created_at, c.id
  `);
  return resolveInstantlyImportTargets(
    result.rows as unknown as CampaignTargetRow[],
    getDeliveryEnv().INSTANTLY_CAMPAIGN_ID,
  );
}