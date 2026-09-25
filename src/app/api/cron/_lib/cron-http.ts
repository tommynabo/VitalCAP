import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/lib/config/env";
import { startCronRun, finishCronRun } from "@/infrastructure/neon/repositories/cron-runs";
import { logEvent } from "@/lib/observability/structured-logger";

/**
 * Shared `/api/cron/*` plumbing (Prompt 7 §25): every cron route must (1)
 * require `CRON_SECRET` bearer auth, (2) persist a `cron_runs` row for
 * every invocation (even failures — never left "running" forever), and (3)
 * emit one structured log line per invocation. Route handlers stay thin —
 * all real domain logic lives in `src/infrastructure/jobs/runners/*`, never
 * duplicated here (§25).
 */
export function isAuthorizedCronRequest(request: NextRequest): boolean {
  const env = getServerEnv();
  if (!env.CRON_SECRET) {
    // env validation already hard-requires CRON_SECRET when APP_ENV === "production" (see lib/config/env.ts),
    // so reaching here with no secret configured only happens in local/dev/test — allow it there only.
    return env.APP_ENV !== "production";
  }
  return request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}

export function unauthorizedCronResponse(): NextResponse {
  return NextResponse.json({ status: "unauthorized" }, { status: 401 });
}

export interface CronWorkResult {
  itemsProcessed: number;
  warnings?: string[];
}

/** Runs `work`, persisting a `cron_runs` row and structured log line for every outcome (success, warnings, or thrown error). */
export async function runCronRoute(route: string, work: () => Promise<CronWorkResult>): Promise<NextResponse> {
  const correlationId = randomUUID();
  const cronRunId = await startCronRun(route);
  const startedAt = Date.now();

  try {
    const result = await work();
    const status = result.warnings && result.warnings.length > 0 ? "completed_with_warnings" : "completed";
    const error = result.warnings && result.warnings.length > 0 ? result.warnings.join("; ") : null;
    await finishCronRun(cronRunId, { status, itemsProcessed: result.itemsProcessed, error });
    logEvent("info", `cron.${route}`, {
      correlationId,
      outcome: status,
      durationMs: Date.now() - startedAt,
      itemsProcessed: result.itemsProcessed,
    });
    return NextResponse.json({ status, itemsProcessed: result.itemsProcessed, warnings: result.warnings ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCronRun(cronRunId, { status: "failed", itemsProcessed: 0, error: message });
    logEvent("error", `cron.${route}`, { correlationId, outcome: "failed", durationMs: Date.now() - startedAt });
    return NextResponse.json({ status: "failed", error: message }, { status: 500 });
  }
}
