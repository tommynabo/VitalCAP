/**
 * Operator-only smoke test for the real Apify Maps provider (Prompt 7 §28).
 * Runs exactly one small, bounded real Actor call against a single actor
 * and prints the result — never wired into `npm test`/CI. Requires
 * APIFY_API_TOKEN. Uses `APIFY_MAPS_FAST_ACTOR` (or `--actor=` override).
 *
 * Usage:
 *   APIFY_API_TOKEN=xxx npm run smoke:maps
 *   APIFY_API_TOKEN=xxx npm run smoke:maps -- --actor=compass/crawler-google-places
 */
import { ApifyMapsDiscoveryProvider } from "../../src/infrastructure/providers/maps/apify-provider";

async function main(): Promise<void> {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    console.error("APIFY_API_TOKEN is required.");
    process.exit(1);
  }

  const actorArg = process.argv.find((a) => a.startsWith("--actor="));
  const actorId = actorArg ? actorArg.split("=")[1] : (process.env.APIFY_MAPS_FAST_ACTOR ?? "bovi/google-maps-scraper");

  const provider = new ApifyMapsDiscoveryProvider({
    apiToken,
    actorId: actorId ?? "bovi/google-maps-scraper",
    dailyCostLimitUsd: Number(process.env.APIFY_DAILY_COST_LIMIT_USD ?? 10),
    batchCostLimitUsd: Number(process.env.APIFY_BATCH_COST_LIMIT_USD ?? 2),
    maxCrawledPlacesPerSearch: 5,
    getTodaySpendUsd: async () => 0,
  });

  console.log(`Running one bounded real search against actor "${actorId}"...`);
  const output = await provider.search({ query: "farmacia", geography: "Madrid", pageToken: null });

  console.log(`Got ${output.results.length} result(s), cost=$${output.usage.costUsd.toFixed(4)}, latency=${output.usage.totalLatencyMs}ms`);
  console.log(JSON.stringify(output.results.slice(0, 3), null, 2));
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
