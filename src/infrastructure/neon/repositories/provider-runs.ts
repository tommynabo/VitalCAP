import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { providerRuns } from "../schema/providers";
import type { ProviderUsageStats } from "@/domain/providers/types";

export interface RecordProviderRunInput {
  workspaceId: string;
  campaignId?: string | null;
  provider: string;
  operation: string;
  externalRunId?: string | null;
  externalDatasetId?: string | null;
  status: "completed" | "failed";
  itemsRequested?: number;
  itemsReturned: number;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

/**
 * Persists one provider-run event (Prompt 7 §14 cost-guard audit trail —
 * actor ID, run ID, dataset ID, status, item count, cost). Used by the real
 * Apify/Serper/MillionVerifier adapters at the composition root; the
 * adapters themselves stay DB-free and only call an injected callback that
 * wraps this function.
 */
export async function recordProviderRun(input: RecordProviderRunInput): Promise<void> {
  const db = getDb();
  await db.insert(providerRuns).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId ?? null,
    provider: input.provider,
    operation: input.operation,
    externalRunId: input.externalRunId ?? null,
    externalDatasetId: input.externalDatasetId ?? null,
    status: input.status,
    itemsRequested: input.itemsRequested ?? 0,
    itemsReturned: input.itemsReturned,
    costUsd: input.costUsd,
    metadata: input.metadata ?? {},
    finishedAt: new Date(),
  });
}

/**
 * Sum of `cost_usd` for a provider within the current UTC calendar day —
 * backs the pre-run daily cost-limit check (§14) without the provider
 * adapter itself needing a DB import.
 */
export async function getTodaySpendUsd(workspaceId: string, provider: string): Promise<number> {
  const db = getDb();
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${providerRuns.costUsd}), 0)` })
    .from(providerRuns)
    .where(and(eq(providerRuns.workspaceId, workspaceId), eq(providerRuns.provider, provider), gte(providerRuns.startedAt, startOfDayUtc)));

  return row?.total ?? 0;
}

/** Real `provider_runs` rows from the last `sinceHours`, folded into `evaluateProviderHealth`'s `ProviderUsageStats` shape (Gate E autopilot cron — feeds real per-engine provider health into `runAutopilotTick`, replacing the previously-hardcoded `"unknown"`). */
export async function getRecentProviderUsage(workspaceId: string, provider: string, sinceHours = 24): Promise<ProviderUsageStats> {
  const db = getDb();
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const rows = await db
    .select({ status: providerRuns.status, itemsReturned: providerRuns.itemsReturned, costUsd: providerRuns.costUsd })
    .from(providerRuns)
    .where(and(eq(providerRuns.workspaceId, workspaceId), eq(providerRuns.provider, provider), gte(providerRuns.startedAt, since)));

  let items = 0;
  let errors = 0;
  let costUsd = 0;
  for (const row of rows) {
    items += row.itemsReturned;
    costUsd += row.costUsd;
    if (row.status === "failed") errors += 1;
  }
  return { calls: rows.length, items, errors, totalLatencyMs: 0, costUsd, quotaRemaining: null };
}
