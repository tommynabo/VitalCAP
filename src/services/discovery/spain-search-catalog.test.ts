import { describe, expect, it } from "vitest";
import { buildHybridMapsSeedCatalog, buildMapsSeedCatalog, buildSerpSeedCatalog, HYBRID_GEOGRAPHIES, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "./spain-search-catalog";
import { SPAIN_PROVINCES } from "@/lib/geography/spain-provinces";

describe("buildMapsSeedCatalog", () => {
  it("creates every canonical ICP query across Spain's complete province/autonomous-city partition", () => {
    const seeds = buildMapsSeedCatalog("camp_1", "maps_fast");
    expect(seeds.length).toBe(ICP_CATEGORY_TERMS.length * SPAIN_PROVINCES.length);
    expect(seeds.every((seed) => seed.engineType === "maps_fast")).toBe(true);
    expect(seeds.every((seed) => seed.totalRaw === 0 && seed.lastRunAt === null)).toBe(true);
  });

  it("produces stable, unique seed ids", () => {
    const seeds = buildMapsSeedCatalog("camp_1", "maps_deep");
    const ids = new Set(seeds.map((seed) => seed.id));
    expect(ids.size).toBe(seeds.length);
  });
});

describe("buildHybridMapsSeedCatalog", () => {
  it("covers complete Spanish geography rather than only major cities", () => {
    const seeds = buildHybridMapsSeedCatalog("camp_1");
    const coveredGeographies = new Set(seeds.map((seed) => seed.geography));

    expect(HYBRID_GEOGRAPHIES).toEqual(SPAIN_PROVINCES.map((province) => province.name));
    expect(coveredGeographies).toEqual(new Set(SPAIN_PROVINCES.map((province) => province.name)));
    expect(seeds).toHaveLength(ICP_CATEGORY_TERMS.length * SPAIN_PROVINCES.length);
  });
});

describe("buildSerpSeedCatalog", () => {
  it("crosses every category term with every province", () => {
    const seeds = buildSerpSeedCatalog("camp_1", "google_serp", ICP_CATEGORY_TERMS);
    expect(seeds.length).toBe(ICP_CATEGORY_TERMS.length * 52);
  });

  it("supports the LinkedIn role-family query set", () => {
    const seeds = buildSerpSeedCatalog("camp_1", "linkedin_owner", LINKEDIN_OWNER_ROLE_QUERIES);
    expect(seeds.length).toBe(LINKEDIN_OWNER_ROLE_QUERIES.length * 52);
    expect(seeds.every((seed) => seed.engineType === "linkedin_owner")).toBe(true);
  });
});
