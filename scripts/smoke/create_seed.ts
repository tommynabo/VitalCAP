import { neon } from "@neondatabase/serverless";
import { buildMapsSeedCatalog } from "../../src/services/discovery/spain-search-catalog";
import { bootstrapSearchSeeds, listSearchSeedsForCampaignEngine } from "../../src/infrastructure/neon/repositories/discovery";

async function main() {
  const campaignId = "65768a11-722f-484e-a0ce-c3eceb46af85";
  const catalog = buildMapsSeedCatalog(campaignId, "maps_fast");
  
  // We just take one seed for the smoke test
  const oneSeed = catalog[0];
  console.log("Selected seed:", oneSeed);
  
  await bootstrapSearchSeeds(campaignId, "maps_fast", [oneSeed!]);
  const seeds = await listSearchSeedsForCampaignEngine(campaignId, "maps_fast");
  console.log("Bootstrapped seeds:", seeds);
}

main().catch(console.error);
