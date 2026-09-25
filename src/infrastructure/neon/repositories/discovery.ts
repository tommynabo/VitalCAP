import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { searchSeeds } from "../schema/discovery";
import { campaigns } from "../schema/campaigns";
import type { SearchSeed } from "@/domain/discovery/types";

function toSearchSeed(row: typeof searchSeeds.$inferSelect): SearchSeed {
  return {
    id: row.id,
    campaignId: row.campaignId,
    engineType: row.engineType as SearchSeed["engineType"],
    query: row.query,
    geography: row.geography,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    totalRaw: row.totalRaw,
    totalUnique: row.totalUnique,
    totalReady: row.totalReady,
    yieldRate: row.yieldRate,
    exhaustionScore: row.exhaustionScore,
    nextEligibleAt: row.nextEligibleAt?.toISOString() ?? null,
  };
}

export async function listSearchSeeds(workspaceId: string): Promise<SearchSeed[]> {
  const db = getDb();
  const rows = await db
    .select({ seed: searchSeeds })
    .from(searchSeeds)
    .innerJoin(campaigns, eq(searchSeeds.campaignId, campaigns.id))
    .where(eq(campaigns.workspaceId, workspaceId));
  return rows.map(({ seed }) => toSearchSeed(seed));
}
