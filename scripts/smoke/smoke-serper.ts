/**
 * Operator-only smoke test for the real Serper.dev provider (Prompt 7 §28).
 * Runs exactly one real search query and prints the result — never wired
 * into `npm test`/CI. Requires SERPER_API_KEY.
 *
 * Usage:
 *   SERPER_API_KEY=xxx npm run smoke:serper
 */
import { SerperDiscoveryProvider } from "../../src/infrastructure/providers/serp/serper-provider";

async function main(): Promise<void> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.error("SERPER_API_KEY is required.");
    process.exit(1);
  }

  const provider = new SerperDiscoveryProvider({
    apiKey,
    country: process.env.SERPER_COUNTRY ?? "es",
    language: process.env.SERPER_LANGUAGE ?? "es",
  });

  console.log('Running one real Serper query for "farmacia Madrid"...');
  const output = await provider.search({ query: "farmacia Madrid", maxResults: 5 });

  console.log(`Got ${output.results.length} result(s), cost=$${output.usage.costUsd.toFixed(4)}, latency=${output.usage.totalLatencyMs}ms`);
  console.log(JSON.stringify(output.results, null, 2));
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
