import type { EngineType } from "@/domain/campaigns/types";
import type { GlobalAutopilotState, EngineTargetState } from "@/domain/autopilot/types";
import type { JobRecord } from "@/domain/discovery/types";
import type { EmailVerificationProvider, WebsiteFetcher } from "@/domain/providers/types";
import { emptyProviderUsageStats } from "@/domain/providers/types";
import { buildMapsSeedCatalog, buildSerpSeedCatalog, ICP_CATEGORY_TERMS, LINKEDIN_OWNER_ROLE_QUERIES } from "../discovery/spain-search-catalog";
import { MockMapsDiscoveryProvider } from "@/infrastructure/providers/maps/mock-provider";
import { MockSerpDiscoveryProvider } from "@/infrastructure/providers/serp/mock-provider";
import { MockEmailVerificationProvider } from "@/infrastructure/providers/email-verification/mock-provider";
import { processRawCandidate, type CandidateRawPayload } from "../discovery/candidate-processor";
import { createInMemoryVerificationCacheStore } from "@/services/verification/email-verification-cache";
import { evaluateProviderHealth, accumulateUsage } from "../discovery/provider-health";
import { claimNextJob, completeJob, failJob } from "@/infrastructure/jobs/job-queue";
import { runAutopilotTick } from "@/services/autopilot/autopilot-scheduler";
import type { AccountIdentitySignals } from "@/services/deduplication/account-dedup";

/**
 * §2.15 integration/demonstration harness: drives all five discovery
 * engines' mock providers for one simulated day, runs every raw candidate
 * through the shared processor with global (cross-engine) dedup, forces a
 * provider outage to exercise pause + Hybrid Fill fallback, forces a job
 * through retry/backoff/dead-letter, and runs one Autopilot Scheduler tick
 * against the resulting engine state. No real network calls, no real
 * sending — purely mocked, per the standing Phase 2 safety decision.
 */

const DAILY_TARGET = 250;
const SOFT_TARGET_PER_ENGINE = 50;

function fakeContactHtml(url: string): string {
  const hostname = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "farmaciasim.es";
  return `<html><body>Contacto: info@${hostname}</body></html>`;
}

const websiteFetcher: WebsiteFetcher = {
  async fetchPage(url: string) {
    return { url, finalUrl: url, status: 200, body: fakeContactHtml(url), contentType: "text/html" };
  },
};

function newAccumulatedUsage() {
  return emptyProviderUsageStats();
}

export interface SimulateAutopilotDayResult {
  totalRawCandidates: number;
  totalProcessed: number;
  totalReady: number;
  duplicatesRejected: number;
  engines: EngineTargetState[];
  state: GlobalAutopilotState;
  jobQueueOutcome: {
    completedJobId: string;
    deadLetteredJobId: string;
  };
  tick: ReturnType<typeof runAutopilotTick>;
  bufferDays: number;
}

export async function simulateAutopilotDay(now: Date = new Date("2025-06-15T12:00:00Z")): Promise<SimulateAutopilotDayResult> {
  const campaignId = "camp_sim";
  const verificationProvider: EmailVerificationProvider = new MockEmailVerificationProvider();
  const verificationCacheStore = createInMemoryVerificationCacheStore();
  const existingAccounts: AccountIdentitySignals[] = [];

  let totalRaw = 0;
  let totalProcessed = 0;
  let totalReady = 0;
  let duplicatesRejected = 0;

  const engineUsage: Record<EngineType, ReturnType<typeof newAccumulatedUsage>> = {
    maps_fast: newAccumulatedUsage(),
    maps_deep: newAccumulatedUsage(),
    google_serp: newAccumulatedUsage(),
    linkedin_owner: newAccumulatedUsage(),
    hybrid_fill: newAccumulatedUsage(),
  };
  const engineReady: Record<EngineType, number> = {
    maps_fast: 0,
    maps_deep: 0,
    google_serp: 0,
    linkedin_owner: 0,
    hybrid_fill: 0,
  };

  async function processAndTally(payload: CandidateRawPayload, engineType: EngineType) {
    totalProcessed += 1;
    const result = await processRawCandidate(payload, engineType, {
      existingAccounts,
      websiteFetcher,
      verificationProvider,
      verificationCacheStore,
      now,
    });
    if (result.isDuplicate) {
      duplicatesRejected += 1;
      return;
    }
    existingAccounts.push({
      accountId: result.accountKey,
      normalizedName: result.businessNameGuess,
    });
    if (result.readyForOutreach) {
      totalReady += 1;
      engineReady[engineType] += 1;
    }
  }

  // --- Maps Fast: healthy provider, one page per seed across a handful of provinces ---
  const mapsFastProvider = new MockMapsDiscoveryProvider();
  const mapsSeeds = buildMapsSeedCatalog(campaignId, "maps_fast").slice(0, 6);
  for (const seed of mapsSeeds) {
    const output = await mapsFastProvider.search({ query: seed.query, geography: seed.geography, pageToken: null });
    engineUsage.maps_fast = accumulateUsage(engineUsage.maps_fast, output.usage);
    totalRaw += output.results.length;
    for (const place of output.results) {
      await processAndTally({ kind: "maps", place }, "maps_fast");
    }
  }

  // --- Maps Deep: same provider, treat every result as deep-enriched (crawledPages already fetched) ---
  const mapsDeepProvider = new MockMapsDiscoveryProvider();
  const deepSeeds = buildMapsSeedCatalog(campaignId, "maps_deep").slice(0, 3);
  for (const seed of deepSeeds) {
    const output = await mapsDeepProvider.search({ query: seed.query, geography: seed.geography, pageToken: null });
    engineUsage.maps_deep = accumulateUsage(engineUsage.maps_deep, output.usage);
    totalRaw += output.results.length;
    for (const place of output.results) {
      const crawledPages = place.websiteUrl
        ? [{ url: place.websiteUrl, body: fakeContactHtml(place.websiteUrl) }]
        : undefined;
      await processAndTally({ kind: "maps", place, crawledPages }, "maps_deep");
    }
  }

  // --- Google SERP: healthy, excludes linkedin.com results upstream (mirrors GoogleSerpEngine) ---
  const serpProvider = new MockSerpDiscoveryProvider();
  const serpSeeds = buildSerpSeedCatalog(campaignId, "google_serp", ICP_CATEGORY_TERMS).slice(0, 6);
  for (const seed of serpSeeds) {
    const output = await serpProvider.search({ query: `${seed.query} ${seed.geography}`, maxResults: 10 });
    engineUsage.google_serp = accumulateUsage(engineUsage.google_serp, output.usage);
    const nonLinkedIn = output.results.filter((r) => r.domain !== "linkedin.com");
    totalRaw += nonLinkedIn.length;
    for (const result of nonLinkedIn) {
      await processAndTally({ kind: "serp", result, geography: seed.geography }, "google_serp");
    }
  }

  // --- LinkedIn Owner: forced provider outage (simulates §2.13 pause) ---
  const linkedInProvider = new MockSerpDiscoveryProvider();
  const linkedInSeeds = buildSerpSeedCatalog(campaignId, "linkedin_owner", LINKEDIN_OWNER_ROLE_QUERIES).slice(0, 4);
  const FORCED_OUTAGE = true;
  for (const seed of linkedInSeeds) {
    if (FORCED_OUTAGE) {
      // Simulate 3 consecutive provider failures to force the health verdict to "paused".
      engineUsage.linkedin_owner = accumulateUsage(engineUsage.linkedin_owner, {
        calls: 1,
        items: 0,
        errors: 1,
        totalLatencyMs: 500,
        costUsd: 0,
        quotaRemaining: null,
      });
      continue;
    }
    const output = await linkedInProvider.search({ query: `${seed.query} ${seed.geography}`, maxResults: 10 });
    engineUsage.linkedin_owner = accumulateUsage(engineUsage.linkedin_owner, output.usage);
    const profiles = output.results.filter((r) => r.domain === "linkedin.com");
    totalRaw += profiles.length;
    for (const profile of profiles) {
      await processAndTally({ kind: "linkedin", profile, resolvedEmployerDomain: null, geography: seed.geography }, "linkedin_owner");
    }
  }
  const linkedInHealth = evaluateProviderHealth(engineUsage.linkedin_owner);

  // --- Hybrid Fill: picks up slack via Maps Fast-shaped candidates, tagged as hybrid_fill ---
  const hybridProvider = new MockMapsDiscoveryProvider();
  const hybridSeeds = buildMapsSeedCatalog(campaignId, "maps_fast").slice(0, 2);
  for (const seed of hybridSeeds) {
    const output = await hybridProvider.search({ query: seed.query, geography: seed.geography, pageToken: null });
    engineUsage.hybrid_fill = accumulateUsage(engineUsage.hybrid_fill, output.usage);
    totalRaw += output.results.length;
    for (const place of output.results) {
      await processAndTally({ kind: "maps", place }, "hybrid_fill");
    }
  }

  // --- Job queue: exercise claim -> complete and claim -> permanent-error -> dead-letter ---
  const jobs: JobRecord[] = [
    {
      id: "job_ok",
      campaignId,
      type: "discovery",
      payload: { engineType: "maps_fast" },
      status: "pending",
      attemptCount: 0,
      maxAttempts: 5,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: null,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: "job_bad",
      campaignId,
      type: "discovery",
      payload: { engineType: "linkedin_owner" },
      status: "pending",
      attemptCount: 0,
      maxAttempts: 5,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: null,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ];

  const claimedOk = claimNextJob(jobs, "worker_1", now);
  const completedOk = claimedOk ? completeJob(claimedOk, now) : null;

  const remaining = jobs.filter((j) => j.id !== claimedOk?.id);
  const claimedBad = claimNextJob(remaining, "worker_1", now);
  const deadLettered = claimedBad ? failJob(claimedBad, new Error("unauthorized: provider quota exhausted"), now) : null;

  // --- Build engine target state + one autopilot scheduler tick ---
  const engines: EngineTargetState[] = (["maps_fast", "maps_deep", "google_serp", "linkedin_owner", "hybrid_fill"] as EngineType[]).map(
    (engineType) => ({
      engineType,
      softTarget: SOFT_TARGET_PER_ENGINE,
      readyToday: engineReady[engineType],
      rawQueueDepth: 0,
      processingQueueDepth: 0,
      currentYield: engineUsage[engineType].calls > 0 ? engineReady[engineType] / Math.max(1, engineUsage[engineType].calls) : 0,
      providerHealth: engineType === "linkedin_owner" ? linkedInHealth : evaluateProviderHealth(engineUsage[engineType]),
      lastRunAt: now.toISOString(),
      nextPlannedAction: null,
    }),
  );

  const state: GlobalAutopilotState = {
    dailyTarget: DAILY_TARGET,
    readyToday: totalReady,
    sentToday: 0,
    repliesToday: 0,
    meetingsToday: 0,
    readyBufferDays: totalReady / (DAILY_TARGET / 3),
    systemHealth: engines.some((e) => e.providerHealth === "paused") ? "degraded" : "healthy",
    engines,
  };

  const tick = runAutopilotTick(state, [...jobs.filter((j) => j.id !== claimedOk?.id && j.id !== claimedBad?.id)], now);
  const bufferDays = totalReady / Math.max(1, DAILY_TARGET / 3);

  return {
    totalRawCandidates: totalRaw,
    totalProcessed,
    totalReady,
    duplicatesRejected,
    engines,
    state,
    jobQueueOutcome: {
      completedJobId: completedOk?.id ?? "",
      deadLetteredJobId: deadLettered?.id ?? "",
    },
    tick,
    bufferDays,
  };
}
