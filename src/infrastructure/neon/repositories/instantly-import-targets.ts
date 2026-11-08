import { sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/neon/db";
import { getDeliveryEnv } from "@/lib/config/env";

export interface InstantImportTarget {
  campaignId: string;
  workspaceId: string;
  providerCampaignId: string;
  legacyFallback: boolean;
}

export interface InstantImportTargetBlock {
  campaignId: string;
  reason: string;
  expectedProviderCampaignId?: string;
}

const STRICT_NICHE_TARGETS: Record<string, string> = {
  yoga_pilates: "7ba53c91-6c8f-4b8a-b260-72eb48f62d07",
  spas_wellness: "20013626-0dc5-4bb4-a2bf-c4b99450cdb6",
  premium_fitness: "5f42f2cf-5ebc-412e-814f-5eca8b1fea71",
  personal_training: "2413f6f5-2e21-46c2-addc-9b8c2ff90a34",
};
const STRICT_NICHE_TARGET_IDS = new Set(Object.values(STRICT_NICHE_TARGETS));

export interface ScopedInstantlyTargetPreflight {
  campaignId: string;
  niche: string | null;
  expectedTarget: string | null;
  actualTarget: string | null;
  mappingEnabled: boolean;
  importReady: boolean;
  blockReason: string | null;
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
): { targets: InstantImportTarget[]; blockedCampaignIds: string[]; blockedCampaignReasons: InstantImportTargetBlock[] } {
  const candidates: InstantImportTarget[] = [];
  const blockedReasons = new Map<string, InstantImportTargetBlock>();
  const rowCounts = new Map<string, number>();
  for (const row of rows) rowCounts.set(row.campaign_id, (rowCounts.get(row.campaign_id) ?? 0) + 1);
  const block = (campaignId: string, reason: string, expectedProviderCampaignId?: string) => {
    if (!blockedReasons.has(campaignId)) {
      blockedReasons.set(campaignId, {
        campaignId,
        reason,
        ...(expectedProviderCampaignId ? { expectedProviderCampaignId } : {}),
      });
    }
  };

  for (const row of rows) {
    if ((rowCounts.get(row.campaign_id) ?? 0) > 1) {
      block(row.campaign_id, "ambiguous_mapping_rows");
      continue;
    }
    const config = row.engine_config !== null && typeof row.engine_config === "object" && !Array.isArray(row.engine_config)
      ? row.engine_config as Record<string, unknown>
      : {};
    const hasNiche = Object.hasOwn(config, "niche");
    const configuredId = [row.mapped_provider_campaign_id, config.instantlyCampaignId, config.providerCampaignId]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    const niche = typeof config.niche === "string" ? config.niche : null;
    const expectedNicheTarget = niche ? STRICT_NICHE_TARGETS[niche] : undefined;
    const strictNicheRoute = hasNiche || (configuredId !== undefined && STRICT_NICHE_TARGET_IDS.has(configuredId));
    if (row.mapping_campaign_id && row.mapping_enabled !== true) {
      block(row.campaign_id, "mapping_disabled", expectedNicheTarget);
      continue;
    }

    if (strictNicheRoute) {
      if (!expectedNicheTarget) {
        block(row.campaign_id, hasNiche ? "unsupported_niche" : "niche_missing");
        continue;
      }
      if (!row.mapping_campaign_id) {
        block(row.campaign_id, "explicit_mapping_missing");
        continue;
      }
      if (row.mapping_campaign_id !== row.campaign_id) {
        block(row.campaign_id, "mapping_campaign_mismatch");
        continue;
      }
      if (row.mapping_enabled !== true) {
        block(row.campaign_id, "mapping_disabled");
        continue;
      }
      if (typeof row.mapped_provider_campaign_id !== "string" || row.mapped_provider_campaign_id.trim().length === 0) {
        block(row.campaign_id, "provider_campaign_id_missing");
        continue;
      }
      if (row.mapped_provider_campaign_id.trim() !== expectedNicheTarget) {
        block(row.campaign_id, "provider_campaign_id_mismatch");
        continue;
      }
      if (expectedNicheTarget === legacyProviderCampaignId.trim()) {
        block(row.campaign_id, "legacy_target_collision");
        continue;
      }

      candidates.push({
        campaignId: row.campaign_id,
        workspaceId: row.workspace_id,
        providerCampaignId: expectedNicheTarget,
        legacyFallback: false,
      });
      continue;
    }

    const legacyFallback = !configuredId && !hasNiche && Boolean(legacyProviderCampaignId.trim());
    const providerCampaignId = configuredId ?? (legacyFallback ? legacyProviderCampaignId.trim() : null);
    if (!providerCampaignId) {
      block(row.campaign_id, "provider_campaign_id_missing");
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
      for (const target of explicitTargets) block(target.campaignId, "shared_provider_campaign_target");
      targets.push(...group.filter((target) => target.legacyFallback));
      continue;
    }
    targets.push(...group);
  }

  const blockedCampaignIds = [...blockedReasons.keys()];
  const blockedCampaignIdSet = new Set(blockedCampaignIds);
  return {
    targets: targets.filter((target) => !blockedCampaignIdSet.has(target.campaignId)),
    blockedCampaignIds,
    blockedCampaignReasons: [...blockedReasons.values()],
  };
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

export async function getScopedInstantlyTargetPreflight(
  campaignId: string,
  workspaceId: string,
): Promise<ScopedInstantlyTargetPreflight | null> {
  const result = await getDb().execute(sql`
    SELECT c.id AS campaign_id, c.workspace_id, c.engine_config,
      mapping.campaign_id AS mapping_campaign_id,
      mapping.enabled AS mapping_enabled,
      mapping.provider_campaign_id AS mapped_provider_campaign_id
    FROM campaigns c
    LEFT JOIN campaign_provider_mappings mapping
      ON mapping.campaign_id = c.id AND mapping.provider = 'instantly'
    WHERE c.id = ${campaignId}::uuid
      AND c.workspace_id = ${workspaceId}::uuid
  `);
  const row = result.rows[0] as CampaignTargetRow | undefined;
  if (!row) return null;
  const resolved = resolveInstantlyImportTargets([row], getDeliveryEnv().INSTANTLY_CAMPAIGN_ID);
  const block = resolved.blockedCampaignReasons[0];
  const config = row.engine_config !== null && typeof row.engine_config === "object" && !Array.isArray(row.engine_config)
    ? row.engine_config as Record<string, unknown>
    : {};
  return {
    campaignId: row.campaign_id,
    niche: typeof config.niche === "string" ? config.niche : null,
    expectedTarget: block?.expectedProviderCampaignId ?? resolved.targets[0]?.providerCampaignId ?? null,
    actualTarget: row.mapped_provider_campaign_id,
    mappingEnabled: row.mapping_enabled === true,
    importReady: resolved.targets.some((target) => target.campaignId === campaignId),
    blockReason: block?.reason ?? null,
  };
}