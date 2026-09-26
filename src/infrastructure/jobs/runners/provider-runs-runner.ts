import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getTodaySpendUsd, listApifyRunsForPolling, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getServerEnv } from "@/lib/config/env";
import { ApifyClient } from "@/infrastructure/providers/maps/apify-client";
import { mapCompassItemToPlaceResult } from "@/infrastructure/providers/maps/apify-actors/compass-adapter";
import { insertRawCandidates, updateSearchSeedRun } from "@/infrastructure/neon/repositories/discovery";
import { enqueueProcessingJob } from "@/infrastructure/neon/repositories/job-queue";

const MONITORED_PROVIDERS = ["apify", "serper", "email_verification"] as const;
const MAX_RUNS_PER_TICK = 20;
const DATASET_PAGE_SIZE = 100;

export async function fetchBoundedDatasetItems(
  client: Pick<ApifyClient, "getDatasetItems">,
  datasetId: string,
  requestedItems: number,
): Promise<Record<string, unknown>[]> {
  const maxItems = Math.min(Math.max(1, requestedItems), 1000);
  const rawItems: Record<string, unknown>[] = [];
  for (let offset = 0; offset < maxItems; offset += DATASET_PAGE_SIZE) {
    const page = await client.getDatasetItems(datasetId, { offset, limit: Math.min(DATASET_PAGE_SIZE, maxItems - offset) });
    const records = page.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    rawItems.push(...records);
    if (records.length < Math.min(DATASET_PAGE_SIZE, maxItems - offset)) break;
  }
  return rawItems;
}

export interface ProviderRunsCheckResult {
  workspacesChecked: number;
  warnings: string[];
}

export interface ProviderRunsCronResult {
  runsChecked: number;
  runsIngested: number;
  candidatesInserted: number;
  warnings: string[];
}

/** Polls a bounded number of durable Compass runs; it never waits for an Actor. */
export async function runProviderRunsCronTick(maxRuns = MAX_RUNS_PER_TICK): Promise<ProviderRunsCronResult> {
  const env = getServerEnv();
  if (!env.APIFY_API_TOKEN) return { runsChecked: 0, runsIngested: 0, candidatesInserted: 0, warnings: ["APIFY_API_TOKEN is not configured."] };

  const client = new ApifyClient({ apiToken: env.APIFY_API_TOKEN });
  const runs = await listApifyRunsForPolling(maxRuns);
  let runsIngested = 0;
  let candidatesInserted = 0;
  const warnings: string[] = [];

  for (const providerRun of runs) {
    try {
      const run = await client.getActorRun(providerRun.externalRunId!);
      const usageCost = run.usageTotalUsd ?? providerRun.costUsd;
      if (run.status === "READY" || run.status === "RUNNING" || run.status === "TIMING-OUT" || run.status === "ABORTING") {
        await updateProviderRun(providerRun.id, { status: "running", externalDatasetId: run.defaultDatasetId ?? providerRun.externalDatasetId, costUsd: usageCost });
        continue;
      }

      if (run.status !== "SUCCEEDED") {
        const terminalStatus = run.status === "ABORTED" ? "aborted" : run.status === "TIMED-OUT" ? "timed_out" : "failed";
        await updateProviderRun(providerRun.id, {
          status: terminalStatus,
          externalDatasetId: run.defaultDatasetId ?? providerRun.externalDatasetId,
          costUsd: usageCost,
          finishedAt: run.finishedAt ? new Date(run.finishedAt) : new Date(),
          error: `Apify run ended with status ${run.status}`,
        });
        continue;
      }

      const datasetId = run.defaultDatasetId ?? providerRun.externalDatasetId;
      if (!datasetId) throw new Error(`Apify run ${run.id} succeeded without a dataset ID.`);
      await updateProviderRun(providerRun.id, {
        status: "succeeded",
        externalDatasetId: datasetId,
        costUsd: usageCost,
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : new Date(),
        error: null,
      });

      const metadata = (providerRun.metadata ?? {}) as Record<string, unknown>;
      const discoveryJobId = typeof metadata.discoveryJobId === "string" ? metadata.discoveryJobId : null;
      if (!discoveryJobId) throw new Error(`Provider run ${providerRun.id} has no discovery job metadata.`);
      const rawItems = await fetchBoundedDatasetItems(client, datasetId, providerRun.itemsRequested || 1);

      const places = rawItems.map(mapCompassItemToPlaceResult).filter((place): place is NonNullable<ReturnType<typeof mapCompassItemToPlaceResult>> => place !== null);
      const insertedIds = await insertRawCandidates(
        places.map((place) => ({
          discoveryJobId,
          campaignId: providerRun.campaignId!,
          engineType: "maps_fast" as const,
          sourceExternalId: place.externalPlaceId,
          sourceUrl: place.sourceUrl,
          rawPayload: { kind: "maps", place },
        })),
      );
      for (const rawCandidateId of insertedIds) {
        await enqueueProcessingJob({ campaignId: providerRun.campaignId!, type: "process_raw_candidate", payload: { rawCandidateId }, idempotencyKey: `raw_candidate:${rawCandidateId}` });
      }

      const seedRunId = typeof metadata.seedRunId === "string" ? metadata.seedRunId : null;
      if (seedRunId) {
        await updateSearchSeedRun(seedRunId, { finishedAt: new Date().toISOString(), rawCount: places.length, uniqueCount: insertedIds.length, readyCount: 0, error: null });
      }
      await updateProviderRun(providerRun.id, { status: "ingested", itemsReturned: places.length, costUsd: usageCost, ingestedAt: new Date(), error: null });
      runsIngested += 1;
      candidatesInserted += insertedIds.length;
    } catch (error) {
      warnings.push(`provider_run ${providerRun.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { runsChecked: runs.length, runsIngested, candidatesInserted, warnings };
}

/** Cost/health audit retained alongside the async poller. */
export async function runProviderRunsCronCheck(): Promise<ProviderRunsCheckResult> {
  const env = getServerEnv();
  const workspaceIds = await listWorkspaceIds();
  const warnings: string[] = [];
  for (const workspaceId of workspaceIds) {
    for (const provider of MONITORED_PROVIDERS) {
      const spend = await getTodaySpendUsd(workspaceId, provider);
      if (provider === "apify" && spend > env.APIFY_DAILY_COST_LIMIT_USD) {
        warnings.push(`workspace ${workspaceId}: apify today's spend $${spend.toFixed(2)} exceeds daily limit $${env.APIFY_DAILY_COST_LIMIT_USD.toFixed(2)}`);
      }
    }
  }
  return { workspacesChecked: workspaceIds.length, warnings };
}
