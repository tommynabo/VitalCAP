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
  "tienda de suplementos",
  "nutrición deportiva",
  "tienda fitness",
  "complementos alimenticios",
] as const;

export const ICP_INTENT_TERMS = ["suplementos", "complementos", "nutrición", "vitaminas", "bienestar"] as const;

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
 * Builds the initial Maps engine seed catalog: one seed per province (Prompt
 * 1's canonical 50-province dataset), rotating query terms are handled by
 * the provider itself — Maps engines search by geography, not by category
 * query the way SERP engines do.
 */
export function buildMapsSeedCatalog(campaignId: string, engineType: "maps_fast" | "maps_deep"): SearchSeed[] {
  return SPAIN_PROVINCES.map((province) => emptySeed(campaignId, engineType, "farmacia", province.name));
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
