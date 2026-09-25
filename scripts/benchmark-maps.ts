/**
 * Operator-only Apify Maps actor benchmark (Prompt 7 §12). Runs the SAME
 * real query/geography against every candidate actor in the registry and
 * measures realized cost per usable unique account — never assumes a
 * headline price. This script makes real, billed Apify API calls and must
 * NEVER be wired into `npm test`, `npm run build`, or any CI workflow.
 *
 * Usage:
 *   APIFY_API_TOKEN=xxx npm run benchmark:maps
 *   APIFY_API_TOKEN=xxx npm run benchmark:maps -- --query="farmacia" --city="Madrid" --max=30
 *   APIFY_API_TOKEN=xxx npm run benchmark:maps -- --include-deep-contact-enrichment
 *
 * Writes a human-readable report to docs/APIFY_ACTOR_BENCHMARK.md.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApifyClient } from "../src/infrastructure/providers/maps/apify-client";
import { APIFY_MAPS_ACTOR_CANDIDATES } from "../src/infrastructure/providers/maps/actor-registry";
import { mapApifyItemToPlaceResult } from "../src/infrastructure/providers/maps/apify-provider";

interface CliArgs {
  query: string;
  city: string;
  max: number;
  includeDeepContactEnrichment: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { query: "farmacia", city: "Madrid", max: 30, includeDeepContactEnrichment: false };
  for (const arg of argv) {
    if (arg === "--include-deep-contact-enrichment") args.includeDeepContactEnrichment = true;
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "query" && value) args.query = value;
    if (key === "city" && value) args.city = value;
    if (key === "max" && value) args.max = Number(value);
  }
  return args;
}

interface ActorBenchmarkResult {
  actorId: string;
  rawPlaces: number;
  uniquePlaces: number;
  spainVerified: number;
  placesWithWebsite: number;
  placesWithPhone: number;
  placesWithEmail: number;
  usableAccounts: number;
  runtimeMs: number;
  errors: number;
  usageTotalUsd: number | null;
  costPerRawPlace: number | null;
  costPerUniquePlace: number | null;
  costPerUsableAccount: number | null;
  errorMessage?: string;
}

function hasEmailField(item: Record<string, unknown>): boolean {
  return typeof item.email === "string" || typeof item.contactEmail === "string" || (Array.isArray(item.emails) && item.emails.length > 0);
}

function safeDivide(numerator: number | null, denominator: number): number | null {
  if (numerator === null || denominator === 0) return null;
  return numerator / denominator;
}

async function benchmarkActor(actorId: string, args: CliArgs, client: ApifyClient): Promise<ActorBenchmarkResult> {
  const start = Date.now();
  try {
    const run = await client.runAndWait(
      actorId,
      {
        searchStringsArray: [args.query],
        locationQuery: args.city,
        countryCode: "es",
        language: "es",
        maxCrawledPlacesPerSearch: args.max,
        scrapeContactInfo: true,
        maximumLeadsEnrichmentRecords: 0,
        skipClosedPlaces: true,
      },
      { maxWaitMs: 180_000, pollIntervalMs: 3_000 },
    );

    if (run.status !== "SUCCEEDED") {
      return {
        actorId,
        rawPlaces: 0,
        uniquePlaces: 0,
        spainVerified: 0,
        placesWithWebsite: 0,
        placesWithPhone: 0,
        placesWithEmail: 0,
        usableAccounts: 0,
        runtimeMs: Date.now() - start,
        errors: 1,
        usageTotalUsd: run.usageTotalUsd,
        costPerRawPlace: null,
        costPerUniquePlace: null,
        costPerUsableAccount: null,
        errorMessage: `run ended with status ${run.status}`,
      };
    }

    const rawItems = (await client.getDatasetItems(run.defaultDatasetId, { limit: args.max })) as Record<string, unknown>[];
    const mapped = rawItems.map(mapApifyItemToPlaceResult);

    const uniqueIds = new Set(mapped.map((m) => m.externalPlaceId));
    const spainVerified = mapped.filter((m) => (m.countryCode ?? "").toUpperCase() === "ES").length;
    const placesWithWebsite = mapped.filter((m) => m.websiteUrl).length;
    const placesWithPhone = mapped.filter((m) => m.phone).length;
    const placesWithEmail = rawItems.filter(hasEmailField).length;
    // Heuristic only (see docs/APIFY_ACTOR_BENCHMARK.md): "usable" here means
    // the shared discovery pipeline would have a channel to enrich/verify
    // from (website OR phone). This is NOT the full candidate-processor
    // eligibility/verification pipeline — it is a fast proxy so this script
    // can run standalone without a live DB.
    const usableAccounts = mapped.filter((m) => m.websiteUrl || m.phone).length;

    const usageTotalUsd = run.usageTotalUsd;
    return {
      actorId,
      rawPlaces: rawItems.length,
      uniquePlaces: uniqueIds.size,
      spainVerified,
      placesWithWebsite,
      placesWithPhone,
      placesWithEmail,
      usableAccounts,
      runtimeMs: Date.now() - start,
      errors: 0,
      usageTotalUsd,
      costPerRawPlace: safeDivide(usageTotalUsd, rawItems.length),
      costPerUniquePlace: safeDivide(usageTotalUsd, uniqueIds.size),
      costPerUsableAccount: safeDivide(usageTotalUsd, usableAccounts),
    };
  } catch (error) {
    return {
      actorId,
      rawPlaces: 0,
      uniquePlaces: 0,
      spainVerified: 0,
      placesWithWebsite: 0,
      placesWithPhone: 0,
      placesWithEmail: 0,
      usableAccounts: 0,
      runtimeMs: Date.now() - start,
      errors: 1,
      usageTotalUsd: null,
      costPerRawPlace: null,
      costPerUniquePlace: null,
      costPerUsableAccount: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatReport(args: CliArgs, results: ActorBenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("# Apify Maps Actor Benchmark");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Query: "${args.query}" · City: "${args.city}" · Max results/actor: ${args.max}`);
  lines.push("");
  lines.push(
    "| actor | raw_places | unique_places | Spain_verified | with_website | with_phone | with_email | usable_accounts | runtime_ms | errors | usageTotalUsd | cost/raw | cost/unique | cost/usable |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.actorId} | ${r.rawPlaces} | ${r.uniquePlaces} | ${r.spainVerified} | ${r.placesWithWebsite} | ${r.placesWithPhone} | ${r.placesWithEmail} | ${r.usableAccounts} | ${r.runtimeMs} | ${r.errors}${r.errorMessage ? ` (${r.errorMessage})` : ""} | ${r.usageTotalUsd ?? "n/a"} | ${r.costPerRawPlace?.toFixed(4) ?? "n/a"} | ${r.costPerUniquePlace?.toFixed(4) ?? "n/a"} | ${r.costPerUsableAccount?.toFixed(4) ?? "n/a"} |`,
    );
  }
  lines.push("");
  lines.push(
    "Actor choice must be based on **realized cost / usable unique account**, not headline price (Prompt 7 §12). " +
      "\"usable\" here is a fast heuristic (website OR phone present) computed standalone by this script, not the full " +
      "candidate-processor eligibility/verification pipeline — treat this as a first-pass signal, not a final yield number.",
  );
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    console.error("APIFY_API_TOKEN is required to run a real benchmark. Aborting — no mock/simulated benchmark is produced.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const client = new ApifyClient({ apiToken });

  const candidates = APIFY_MAPS_ACTOR_CANDIDATES.filter(
    (c) => args.includeDeepContactEnrichment || c.role !== "deep_contact_enrichment",
  );

  console.log(`Benchmarking ${candidates.length} actor(s) with query="${args.query}" city="${args.city}" max=${args.max}...`);
  const results: ActorBenchmarkResult[] = [];
  for (const candidate of candidates) {
    console.log(`\n→ Running ${candidate.actorId} (${candidate.label})...`);
    const result = await benchmarkActor(candidate.actorId, args, client);
    results.push(result);
    console.log(`  done in ${result.runtimeMs}ms — raw=${result.rawPlaces} usable=${result.usableAccounts} cost=${result.usageTotalUsd ?? "n/a"}`);
  }

  const report = formatReport(args, results);
  console.log(`\n${report}`);

  const outPath = join(process.cwd(), "docs", "APIFY_ACTOR_BENCHMARK.md");
  writeFileSync(outPath, report, "utf-8");
  console.log(`\nReport written to ${outPath}`);
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
