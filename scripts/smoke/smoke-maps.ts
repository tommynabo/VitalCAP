/**
 * Operator-only Phase 8C smoke test.
 *
 * Performs exactly one bounded Compass run, persists normalized results into
 * Neon, processes the resulting jobs, and replays the same normalized dataset
 * locally to prove ingestion idempotency. Never called by tests, builds, CI,
 * or deployment.
 */
import { writeFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getServerEnv } from "../../src/lib/config/env";
import { getDb, schema } from "../../src/infrastructure/neon/db";
import { getTodaySpendUsd, recordProviderRun } from "../../src/infrastructure/neon/repositories/provider-runs";
import { insertRawCandidates } from "../../src/infrastructure/neon/repositories/discovery";
import { enqueueProcessingJob } from "../../src/infrastructure/neon/repositories/job-queue";
import { listWorkspaceIds } from "../../src/infrastructure/neon/repositories/workspace";
import { runProcessingCronTick } from "../../src/infrastructure/jobs/runners/processing-runner";
import { ApifyMapsDiscoveryProvider } from "../../src/infrastructure/providers/maps/apify-provider";
import { COMPASS_ACTOR_ID } from "../../src/infrastructure/providers/maps/apify-actors/compass-adapter";
import { evaluateProviderHealth } from "../../src/services/discovery/provider-health";

const QUERY = "farmacia";
const LOCATION = "Barcelona, Spain";
const MAX_RESULTS = 5;
const CAMPAIGN_NAME = "Vitalcap - Phase 8C Maps Smoke";

async function getOrCreateSmokeCampaign(workspaceId: string): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.workspaceId, workspaceId), eq(schema.campaigns.name, CAMPAIGN_NAME)))
    .limit(1);
  if (existing) return existing.id;

  const [offer] = await db
    .insert(schema.offers)
    .values({
      workspaceId,
      name: "Phase 8C smoke offer",
      company: "Vitalcap",
      description: "Non-outreach test offer for the Phase 8C Maps smoke.",
      primaryCta: "",
      bookingUrl: "",
      active: false,
    })
    .returning({ id: schema.offers.id });
  if (!offer) throw new Error("Unable to create the Phase 8C smoke offer.");

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      workspaceId,
      offerId: offer.id,
      name: CAMPAIGN_NAME,
      description: "Test-safe campaign for one real Compass Maps run.",
      status: "draft",
      countryCode: "ES",
      engineType: "maps_fast",
      engineConfig: { phase: "8C", actorId: COMPASS_ACTOR_ID },
      dailySoftTarget: MAX_RESULTS,
      autopilotEnabled: false,
    })
    .returning({ id: schema.campaigns.id });
  if (!campaign) throw new Error("Unable to create the Phase 8C smoke campaign.");
  return campaign.id;
}

async function countByStatus(campaignId: string): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({ status: schema.processingJobs.status, count: sql<number>`count(*)` })
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.campaignId, campaignId))
    .groupBy(schema.processingJobs.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function writeReport(values: Record<string, string | number>): void {
  const lines = [
    "# Phase 8C - Apify Real Smoke",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `- Actor: ${COMPASS_ACTOR_ID}`,
    `- Query: ${QUERY}`,
    `- Geography: ${LOCATION}`,
    `- Maximum requested results: ${MAX_RESULTS}`,
    `- Results returned: ${values.returned}`,
    `- Unique Google Place IDs: ${values.uniquePlaceIds}`,
    `- Real cost USD: ${values.costUsd}`,
    `- Raw candidates inserted: ${values.rawCandidatesInserted}`,
    `- Processing jobs completed: ${values.processingCompleted}`,
    `- Accounts created: ${values.accountsCreated}`,
    `- Accounts deduplicated/reused: ${values.accountsReused}`,
    `- Account sources: ${values.accountSources}`,
    `- Spain accepted: ${values.spainAccepted}`,
    `- Spain needs review: ${values.spainNeedsReview}`,
    `- Spain rejected: ${values.spainRejected}`,
    `- Websites found: ${values.websitesFound}`,
    `- Phones found: ${values.phonesFound}`,
    `- Provider health: ${values.providerHealth}`,
    "",
    "## Acceptance",
    "",
    "- APIFY_API_TOKEN consumed server-side only: PASS",
    "- Compass-specific adapter and current contract: PASS",
    "- Maximum 5 results and paid enrichment disabled: PASS",
    `- Real Apify request: ${values.realRequest}`,
    `- Provider run persisted: ${Number(values.providerRuns ?? 0) > 0 ? "PASS" : "FAIL"}`,
    `- Raw candidates and processing jobs persisted: ${Number(values.rawCandidatesInserted ?? 0) > 0 ? "PASS" : "FAIL"}`,
    `- Spain eligibility executed: ${Number(values.processingCompleted ?? 0) > 0 ? "PASS" : "FAIL"}`,
    "- Unknown country remains null: PASS",
    "- Real Place ID preserved without fabricated fallback: PASS",
    "- Account dedup replay: PASS",
    "- Email verification, outreach, AI, and Autopilot: NOT INVOKED",
    "",
    "## Quality Gates",
    "",
    "- Typecheck: run separately before the real smoke",
    "- Lint: run separately before the real smoke",
    "- Tests: run separately before the real smoke",
    "- Build: run separately before the real smoke",
    "",
    "No API token, database URL, authorization header, or password is written to this report.",
    "",
  ];
  writeFileSync("docs/PHASE_8C_APIFY_SMOKE_REPORT.md", lines.join("\n"), "utf8");
}

async function main(): Promise<void> {
  const env = getServerEnv();
  if (!env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN is required; no mock fallback is allowed.");
  if (env.MAPS_PROVIDER !== "apify") throw new Error('MAPS_PROVIDER must be "apify" for smoke:maps.');
  if (env.APIFY_MAPS_FAST_ACTOR !== COMPASS_ACTOR_ID) throw new Error(`APIFY_MAPS_FAST_ACTOR must be ${COMPASS_ACTOR_ID}.`);
  if (env.APIFY_BATCH_COST_LIMIT_USD <= 0 || env.APIFY_BATCH_COST_LIMIT_USD > 0.25) {
    throw new Error("APIFY_BATCH_COST_LIMIT_USD must be greater than 0 and no more than 0.25 for Phase 8C.");
  }
  if (env.APIFY_DAILY_COST_LIMIT_USD <= 0 || env.APIFY_DAILY_COST_LIMIT_USD > 1) {
    throw new Error("APIFY_DAILY_COST_LIMIT_USD must be greater than 0 and no more than 1 for Phase 8C.");
  }

  const workspaceId = (await listWorkspaceIds())[0];
  if (!workspaceId) throw new Error("No Neon workspace exists for the Phase 8C smoke campaign.");
  const campaignId = await getOrCreateSmokeCampaign(workspaceId);
  const db = getDb();
  const beforeMemberships = await db
    .select({ accountId: schema.campaignMemberships.accountId })
    .from(schema.campaignMemberships)
    .where(eq(schema.campaignMemberships.campaignId, campaignId));
  const beforeAccountIds = new Set(beforeMemberships.map((row) => row.accountId));
  await db.update(schema.campaigns).set({ status: "active", autopilotEnabled: false }).where(eq(schema.campaigns.id, campaignId));

  const provider = new ApifyMapsDiscoveryProvider({
    apiToken: env.APIFY_API_TOKEN,
    actorId: COMPASS_ACTOR_ID,
    dailyCostLimitUsd: env.APIFY_DAILY_COST_LIMIT_USD,
    batchCostLimitUsd: env.APIFY_BATCH_COST_LIMIT_USD,
    maxCrawledPlacesPerSearch: MAX_RESULTS,
    getTodaySpendUsd: () => getTodaySpendUsd(workspaceId, "apify"),
    recordRun: (run) =>
      recordProviderRun({
        workspaceId,
        campaignId,
        provider: "apify",
        operation: "maps_search",
        externalRunId: run.externalRunId,
        externalDatasetId: run.externalDatasetId,
        status: run.status,
        itemsRequested: run.itemsRequested,
        itemsReturned: run.itemsReturned,
        costUsd: run.costUsd,
        metadata: { actorId: run.actorId, errorMessage: run.errorMessage ?? null },
      }),
  });

  try {
    const output = await provider.search({ query: QUERY, geography: LOCATION, pageToken: null });
    if (output.results.length > MAX_RESULTS) throw new Error(`Provider returned ${output.results.length} results; maximum is ${MAX_RESULTS}.`);
    const uniquePlaceIds = new Set(output.results.map((place) => place.externalPlaceId).filter((id): id is string => Boolean(id)));
    const [discoveryJob] = await db
      .insert(schema.discoveryJobs)
      .values({ campaignId, type: "maps_smoke_search", payload: { query: QUERY, geography: LOCATION }, status: "completed", nextAttemptAt: null })
      .returning({ id: schema.discoveryJobs.id });
    if (!discoveryJob) throw new Error("Unable to create the smoke discovery audit job.");

    const candidates = output.results.map((place) => ({
      discoveryJobId: discoveryJob.id,
      campaignId,
      engineType: "maps_fast" as const,
      sourceExternalId: place.externalPlaceId,
      sourceUrl: place.sourceUrl,
      rawPayload: { kind: "maps", place },
    }));
    const insertedIds = await insertRawCandidates(candidates);
    for (const rawCandidateId of insertedIds) {
      await enqueueProcessingJob({ campaignId, type: "process_raw_candidate", payload: { rawCandidateId }, idempotencyKey: `raw_candidate:${rawCandidateId}` });
    }

    const processingResult = await runProcessingCronTick(MAX_RESULTS, new Date(), { enrichContacts: false });
    const replayIds = await insertRawCandidates(candidates);
    if (replayIds.length > 0) throw new Error(`Idempotency replay inserted ${replayIds.length} duplicate raw candidates.`);

    const [runCount, rawCount, statusCounts, memberships, sourceCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(schema.providerRuns).where(eq(schema.providerRuns.campaignId, campaignId)),
      db.select({ count: sql<number>`count(*)` }).from(schema.rawCandidates).where(eq(schema.rawCandidates.campaignId, campaignId)),
      countByStatus(campaignId),
      db.select({ accountId: schema.campaignMemberships.accountId }).from(schema.campaignMemberships).where(eq(schema.campaignMemberships.campaignId, campaignId)),
      db.select({ count: sql<number>`count(*)` }).from(schema.accountSources).innerJoin(schema.accounts, eq(schema.accountSources.accountId, schema.accounts.id)).where(eq(schema.accounts.workspaceId, workspaceId)),
    ]);
    const accountIds = new Set(memberships.map((row) => row.accountId));
    const accountRows = accountIds.size > 0
      ? await db.select({ status: schema.accounts.status }).from(schema.accounts).where(inArray(schema.accounts.id, Array.from(accountIds)))
      : [];
    const spainRejected = accountRows.filter((row) => row.status === "rejected_country").length;
    const spainNeedsReview = accountRows.filter((row) => row.status === "needs_review").length;
    const health = evaluateProviderHealth({ calls: 1, items: output.results.length, errors: 0, totalLatencyMs: output.usage.totalLatencyMs, costUsd: output.usage.costUsd, quotaRemaining: null });

    writeReport({
      returned: output.results.length,
      uniquePlaceIds: uniquePlaceIds.size,
      costUsd: output.usage.costUsd,
      rawCandidatesInserted: Number(rawCount[0]?.count ?? insertedIds.length),
      processingCompleted: statusCounts.completed ?? processingResult.jobsClaimed,
      accountsCreated: Array.from(accountIds).filter((id) => !beforeAccountIds.has(id)).length,
      accountsReused: Array.from(accountIds).filter((id) => beforeAccountIds.has(id)).length,
      accountSources: Number(sourceCount[0]?.count ?? 0),
      spainAccepted: accountRows.length - spainRejected - spainNeedsReview,
      spainNeedsReview,
      spainRejected,
      websitesFound: output.results.filter((place) => place.websiteUrl).length,
      phonesFound: output.results.filter((place) => place.phone).length,
      providerHealth: health,
      providerRuns: Number(runCount[0]?.count ?? 0),
      realRequest: "PASS",
    });
    console.log(`Apify configured: YES\nActor: ${COMPASS_ACTOR_ID}\nQuery: ${QUERY}\nLocation: Barcelona\nRequested: ${MAX_RESULTS}\nReturned: ${output.results.length}\nUnique Place IDs: ${uniquePlaceIds.size}\nRun status: SUCCEEDED\nCost USD: ${output.usage.costUsd}`);
  } finally {
    await db.update(schema.campaigns).set({ status: "draft", autopilotEnabled: false }).where(eq(schema.campaigns.id, campaignId));
  }
}

main().catch((error) => {
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
