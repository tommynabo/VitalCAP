import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDayBounds } from "@/lib/time/day-bounds";
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
  status: ProviderRunStatus;
  requestKey?: string | null;
  actorId?: string | null;
  seedId?: string | null;
  ingestedAt?: Date | null;
  error?: string | null;
  itemsRequested?: number;
  itemsReturned: number;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

export type ProviderRunStatus = "starting" | "queued" | "running" | "succeeded" | "failed" | "aborted" | "timed_out" | "ingested" | "completed";

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
    requestKey: input.requestKey ?? null,
    actorId: input.actorId ?? null,
    seedId: input.seedId ?? null,
    externalRunId: input.externalRunId ?? null,
    externalDatasetId: input.externalDatasetId ?? null,
    status: input.status,
    itemsRequested: input.itemsRequested ?? 0,
    itemsReturned: input.itemsReturned,
    costUsd: input.costUsd,
    metadata: input.metadata ?? {},
    ingestedAt: input.ingestedAt ?? null,
    error: input.error ?? null,
    startedAt: new Date(),
    finishedAt: input.status === "queued" || input.status === "running" ? null : new Date(),
  });
}

export interface CreateProviderRunInput {
  workspaceId: string;
  campaignId: string;
  provider: string;
  operation: string;
  requestKey: string;
  actorId: string;
  seedId: string;
  externalRunId: string;
  externalDatasetId: string | null;
  status: "queued" | "running";
  itemsRequested: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface ReserveApifyProviderRunInput {
  workspaceId: string;
  campaignId: string;
  operation: string;
  requestKey: string;
  actorId?: string | null;
  seedId: string;
  itemsRequested: number;
  metadata?: Record<string, unknown>;
}

export async function reserveApifyProviderRun(input: ReserveApifyProviderRunInput): Promise<{ providerRun: typeof providerRuns.$inferSelect; created: boolean }> {
  const db = getDb();
  const [inserted] = await db
    .insert(providerRuns)
    .values({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      provider: "apify",
      operation: input.operation,
      requestKey: input.requestKey,
      actorId: input.actorId ?? null,
      seedId: input.seedId,
      status: "starting",
      itemsRequested: input.itemsRequested,
      itemsReturned: 0,
      costUsd: 0,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({ target: providerRuns.requestKey })
    .returning();
  if (inserted) return { providerRun: inserted, created: true };
  const existing = await getProviderRunByRequestKey(input.requestKey);
  if (!existing) throw new Error(`Unable to resolve provider run request key ${input.requestKey}.`);
  return { providerRun: existing, created: false };
}

export async function createProviderRun(input: CreateProviderRunInput): Promise<string> {
  const db = getDb();
  const [inserted] = await db
    .insert(providerRuns)
    .values({ ...input, costUsd: input.costUsd ?? 0, metadata: input.metadata ?? {}, itemsReturned: 0 })
    .onConflictDoNothing({ target: providerRuns.requestKey })
    .returning({ id: providerRuns.id });
  if (inserted) return inserted.id;
  const existing = await getProviderRunByRequestKey(input.requestKey);
  if (!existing) throw new Error(`Unable to resolve provider run request key ${input.requestKey}.`);
  return existing.id;
}

export async function getProviderRunByRequestKey(requestKey: string) {
  const db = getDb();
  const [row] = await db.select().from(providerRuns).where(eq(providerRuns.requestKey, requestKey)).limit(1);
  return row ?? null;
}

export async function listApifyRunsForPolling(limit: number) {
  const db = getDb();
  return db
    .select()
    .from(providerRuns)
    .where(and(eq(providerRuns.provider, "apify"), inArray(providerRuns.status, ["starting", "queued", "running", "succeeded"])))
    .orderBy(asc(providerRuns.startedAt), asc(providerRuns.id))
    .limit(limit);
}

export async function updateProviderRun(
  id: string,
  patch: Partial<{
    status: ProviderRunStatus;
    externalRunId: string | null;
    actorId: string | null;
    externalDatasetId: string | null;
    itemsReturned: number;
    costUsd: number;
    finishedAt: Date | null;
    ingestedAt: Date | null;
    error: string | null;
    metadata: Record<string, unknown>;
  }>,
): Promise<void> {
  const db = getDb();
  await db.update(providerRuns).set(patch).where(eq(providerRuns.id, id));
}

/**
 * Sum of `cost_usd` for a provider within the current UTC calendar day —
 * backs the pre-run daily cost-limit check (§14) without the provider
 * adapter itself needing a DB import.
 */
export async function getTodaySpendUsd(workspaceId: string, provider: string, timeZone = "Europe/Madrid", now = new Date()): Promise<number> {
  const db = getDb();
  const { start, end } = getDayBounds(timeZone, now);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${providerRuns.costUsd}), 0)` })
    .from(providerRuns)
    .where(and(eq(providerRuns.workspaceId, workspaceId), eq(providerRuns.provider, provider), gte(providerRuns.startedAt, start), sql`${providerRuns.startedAt} < ${end}`));

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
