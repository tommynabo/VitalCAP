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

export type ProviderRunStatus = "starting" | "queued" | "running" | "succeeded" | "ingesting" | "failed" | "aborted" | "timed_out" | "ingested" | "completed" | "budget_blocked" | "manual_reconciliation_required";

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
  
  // 1. Get settings and limits
  const { autopilotSettings } = await import("../schema/autopilot");
  const [settings] = await db.select({
    timezone: autopilotSettings.timezone,
    maxDailySpend: autopilotSettings.maxDailyApifySpendUsd
  }).from(autopilotSettings).where(eq(autopilotSettings.workspaceId, input.workspaceId));
  if (!settings) throw new Error("Autopilot settings not found for workspace.");

  const env = await import("@/lib/config/env");
  const maxRequests = env.getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS;
  const maxCost = Math.min(env.getMapsEnv().APIFY_DAILY_COST_LIMIT_USD, settings.maxDailySpend ?? Number.POSITIVE_INFINITY);
  
  const { start } = getDayBounds(settings.timezone);
  const expectedCostUsd = input.itemsRequested * 0.005; // conservative

  // 2. Atomic insertion with guard conditions in one Neon HTTP statement.
  const result = await db.execute(sql`
    WITH safety AS (
      SELECT
        (SELECT COUNT(*) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND status = 'manual_reconciliation_required')::int as unreconciled_count,
        (SELECT COALESCE(SUM(items_requested), 0) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND provider = 'apify' AND started_at >= ${start.toISOString()}::timestamptz)::int as requested_today,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM provider_runs WHERE workspace_id = ${input.workspaceId}::uuid AND provider = 'apify' AND started_at >= ${start.toISOString()}::timestamptz)::numeric as cost_today
    ),
    inserted AS (
      INSERT INTO provider_runs (
        workspace_id, campaign_id, provider, operation, request_key, actor_id, seed_id, status, items_requested, items_returned, cost_usd, metadata, started_at
      )
      SELECT
        ${input.workspaceId}::uuid, ${input.campaignId}::uuid, 'apify', ${input.operation}, ${input.requestKey}, 
        ${input.actorId ?? null}, ${input.seedId}::uuid, 'starting', ${input.itemsRequested}, 0, ${expectedCostUsd}, 
        ${JSON.stringify(input.metadata ?? {})}::jsonb, NOW()
      FROM safety
      WHERE safety.unreconciled_count = 0
        AND safety.requested_today + ${input.itemsRequested} <= ${maxRequests}
        AND safety.cost_today + ${expectedCostUsd} <= ${maxCost}
      ON CONFLICT (request_key) DO NOTHING
      RETURNING *
    )
    SELECT
      (SELECT row_to_json(inserted.*) FROM inserted) AS inserted_row,
      (SELECT row_to_json(safety.*) FROM safety) AS safety_row,
      (SELECT row_to_json(existing.*) FROM provider_runs existing WHERE existing.request_key = ${input.requestKey}) AS existing_row
  `);

  const row = result.rows[0] as {
    inserted_row: unknown;
    safety_row: { unreconciled_count: number; requested_today: number; cost_today: number } | null;
    existing_row: unknown;
  } | undefined;
  if (row?.inserted_row) {
    const insertedRow = await getProviderRunByRequestKey(input.requestKey);
    if (!insertedRow) throw new Error("Created provider run reservation could not be loaded.");
    return { providerRun: insertedRow, created: true };
  }
  if (row?.existing_row) {
    const existing = await getProviderRunByRequestKey(input.requestKey);
    if (!existing) throw new Error("Existing provider run reservation could not be loaded.");
    return { providerRun: existing, created: false };
  }

  const safety = row?.safety_row;
  if (safety?.unreconciled_count) {
    throw new Error(`Provider run reservation rejected: unresolved manual reconciliation required for workspace ${input.workspaceId}`);
  }
  if (safety && safety.requested_today + input.itemsRequested > maxRequests) {
    throw new Error(`Provider run reservation rejected: max daily requests exceeded for workspace ${input.workspaceId}`);
  }
  if (safety && safety.cost_today + expectedCostUsd > maxCost) {
    throw new Error(`Provider run reservation rejected: daily cost limit exceeded for workspace ${input.workspaceId}`);
  }
  throw new Error(`Unable to resolve provider run reservation for workspace ${input.workspaceId}`);
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

export async function claimProviderRunForIngestion(id: string, token: string) {
  const db = getDb();
  const [claimed] = await db
    .update(providerRuns)
    .set({
      status: "ingesting",
      ingestionStartedAt: new Date(),
      ingestionAttemptCount: sql`${providerRuns.ingestionAttemptCount} + 1`,
      ingestionClaimToken: token,
    })
    .where(and(eq(providerRuns.id, id), eq(providerRuns.status, "succeeded")))
    .returning();
  return claimed ?? null;
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
    seedRunId: string | null;
    lastIngestionError: string | null;
  }>,
): Promise<void> {
  const db = getDb();
  await db.update(providerRuns).set(patch).where(eq(providerRuns.id, id));
}

export async function recoverFailedIngestion(id: string, token: string, workspaceId: string, errorString: string): Promise<void> {
  const db = getDb();
  const [current] = await db.select({ attempt: providerRuns.ingestionAttemptCount }).from(providerRuns).where(and(eq(providerRuns.id, id), eq(providerRuns.ingestionClaimToken, token)));
  if (!current) return;
  
  if (current.attempt < 5) {
    await db.update(providerRuns).set({
      status: "succeeded",
      ingestionClaimToken: null,
      ingestionStartedAt: null,
      lastIngestionError: errorString
    }).where(and(eq(providerRuns.id, id), eq(providerRuns.ingestionClaimToken, token)));
  } else {
    await db.update(providerRuns).set({
      status: "manual_reconciliation_required",
      lastIngestionError: errorString
    }).where(and(eq(providerRuns.id, id), eq(providerRuns.ingestionClaimToken, token)));
    
    // Autopilot settings update
    const { autopilotSettings } = await import("../schema/autopilot");
    await db.update(autopilotSettings).set({
      systemPaused: true,
      systemPauseReason: "provider_reconciliation",
      updatedAt: new Date()
    }).where(eq(autopilotSettings.workspaceId, workspaceId));
  }
}

/**
 * Sum of `cost_usd` for a provider within the current UTC calendar day.
 * Semantics of `cost_usd`: 
 * - Represents the reserved expected cost until the run is terminal.
 * - Represents the actual final cost afterward.
 * This budget query accounts conservatively without double-counting.
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
    if (row.status !== "succeeded" && row.status !== "ingested" && row.status !== "completed" && row.status !== "failed" && row.status !== "aborted" && row.status !== "timed_out") continue;
    items += row.itemsReturned;
    costUsd += row.costUsd;
    if (row.status === "failed" || row.status === "aborted" || row.status === "timed_out") errors += 1;
  }
  const terminalRows = rows.filter((row) => ["succeeded", "ingested", "completed", "failed", "aborted", "timed_out"].includes(row.status));
  return { calls: terminalRows.length, items, errors, totalLatencyMs: 0, costUsd, quotaRemaining: null };
}
