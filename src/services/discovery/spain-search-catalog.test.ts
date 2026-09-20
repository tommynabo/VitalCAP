import { describe, expect, it } from "vitest";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "./spain-search-catalog";

describe("buildMapsSeedCatalog", () => {
  it("creates one seed per Spain province/autonomous city", () => {
    const seeds = buildMapsSeedCatalog("camp_1", "maps_fast");
    expect(seeds.length).toBe(52);
    expect(seeds.every((seed) => seed.engineType === "maps_fast")).toBe(true);
    expect(seeds.every((seed) => seed.totalRaw === 0 && seed.lastRunAt === null)).toBe(true);
  });

  it("produces stable, unique seed ids", () => {
    const seeds = buildMapsSeedCatalog("camp_1", "maps_deep");
    const ids = new Set(seeds.map((seed) => seed.id));
    expect(ids.size).toBe(seeds.length);
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
