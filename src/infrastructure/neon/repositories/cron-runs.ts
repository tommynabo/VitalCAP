import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { cronRuns } from "../schema/jobs-meta";

/**
 * Persisted cron run status (Prompt 7 §25 — every `/api/cron/*` route must
 * persist its run status). Call `startCronRun` immediately after auth
 * passes, then always `finishCronRun` in a `finally` block so a route that
 * throws still leaves an honest "failed" record instead of an eternally
 * "running" one.
 */
export async function startCronRun(route: string): Promise<string> {
  const db = getDb();
  const [row] = await db.insert(cronRuns).values({ route, status: "running" }).returning({ id: cronRuns.id });
  if (!row) throw new Error("Failed to start cron run record.");
  return row.id;
}

export interface FinishCronRunInput {
  status: "completed" | "completed_with_warnings" | "failed";
  itemsProcessed: number;
  error?: string | null;
}

export async function finishCronRun(cronRunId: string, input: FinishCronRunInput): Promise<void> {
  const db = getDb();
  await db
    .update(cronRuns)
    .set({ status: input.status, itemsProcessed: input.itemsProcessed, error: input.error ?? null, finishedAt: new Date() })
    .where(eq(cronRuns.id, cronRunId));
}
