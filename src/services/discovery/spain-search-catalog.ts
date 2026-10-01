import type { EngineType } from "@/domain/campaigns/types";
import type { SearchSeed } from "@/domain/discovery/types";
import { SPAIN_PROVINCES } from "@/lib/geography/spain-provinces";

/**
 * ICP category terms consumed by query-expanding engines (§2.8). Kept in
 * one place so `google_serp`/`linkedin_owner` seed generation and any
 * future engine share the exact same vocabulary instead of drifting.
 */
export const ICP_CATEGORY_TERMS = [
  "farmacia",
  "farmacia independiente",
  "parafarmacia",
  "herbolario",
  "herbolaria",
] as const;

/**
 * Hybrid Fill uses the same complete Spain partition as the regular Maps
 * engines. Provinces/autonomous cities are search partitions only: they do
 * not impose a city, municipality, population, or urban/rural eligibility
 * rule on a business.
 */
export const HYBRID_GEOGRAPHIES = SPAIN_PROVINCES.map((province) => province.name);

export const ICP_INTENT_TERMS = [] as const;

function seedId(engineType: EngineType, query: string, geography: string): string {
  const slug = `${query}_${geography}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_");
  return `seed_${engineType}_${slug}`;
}

function emptySeed(campaignId: string, engineType: EngineType, query: string, geography: string): SearchSeed {
  return {
    id: seedId(engineType, query, geography),
    campaignId,
    engineType,
    query,
    geography,
    lastRunAt: null,
    totalRaw: 0,
    totalUnique: 0,
    totalReady: 0,
    yieldRate: 0,
    exhaustionScore: 0,
    nextEligibleAt: null,
  };
}

/**
 * Builds the Maps seed catalog: every canonical ICP term across every Spanish
 * province/autonomous city. Geography is used solely to make nationwide
 * coverage tractable; it never filters candidates by city or population.
 */
export function buildMapsSeedCatalog(campaignId: string, engineType: "maps_fast" | "maps_deep"): SearchSeed[] {
  return ICP_CATEGORY_TERMS.flatMap((query) =>
    SPAIN_PROVINCES.map((province) => emptySeed(campaignId, engineType, query, province.name)),
  );
}

export function buildHybridMapsSeedCatalog(campaignId: string): SearchSeed[] {
  return HYBRID_GEOGRAPHIES.flatMap((geography) =>
    ICP_CATEGORY_TERMS.map((query) => emptySeed(campaignId, "maps_fast", query, geography)),
  );
}

/**
 * Builds the Google SERP / LinkedIn Owner seed catalog: category (or role
 * family, for LinkedIn) × province. Deliberately does not cross every
 * category with every municipality — that combinatorial explosion is what
 * §2.8 explicitly warns against; the geography planner (not this catalog
 * builder) is what keeps yield-tracked and chooses which of these seeds to
 * actually run next.
 */
export function buildSerpSeedCatalog(
  campaignId: string,
  engineType: "google_serp" | "linkedin_owner",
  queryTerms: readonly string[],
): SearchSeed[] {
  const seeds: SearchSeed[] = [];
  for (const term of queryTerms) {
    for (const province of SPAIN_PROVINCES) {
      seeds.push(emptySeed(campaignId, engineType, term, province.name));
    }
  }
  return seeds;
}

export const LINKEDIN_OWNER_ROLE_QUERIES = [
  "titular farmacéutico",
  "titular farmacia",
  "propietario farmacia",
  "dueño farmacia",
  "gerente farmacia",
  "responsable de compras farmacia",
] as const;
