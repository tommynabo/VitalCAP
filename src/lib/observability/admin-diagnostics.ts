/**
 * Admin diagnostics snapshot (Prompt 6 §6.3) — the data model behind the
 * non-nav `/admin/diagnostics` view. Deliberately a pure aggregation
 * function: it takes whatever job/provider/cron/webhook signals the caller
 * already has and returns one composed snapshot, so it works the same
 * whether those signals come from Supabase or dev-seed fixtures, and is
 * fully unit-testable without a request/response cycle.
 */

import type { ProviderHealthStatus } from "@/domain/autopilot/types";
import type { QueueHealthSnapshot } from "@/services/autopilot/queue-health-service";

export interface ProviderHealthRow {
  name: string;
  status: ProviderHealthStatus | "connected" | "missing_configuration";
  detail: string;
}

export interface AdminDiagnosticsInput {
  /** Caller computes this via `evaluateQueueHealth(jobs, now)` — kept as an input, not re-derived here, so this module never needs raw job records. */
  queueHealth: QueueHealthSnapshot;
  now: Date;
  providers: ProviderHealthRow[];
  cronLastRunAt: string | null;
  webhookLastEventAt: string | null;
  dbConnectivityOk: boolean;
  currentTargetState: {
    dailyTarget: number;
    readyToday: number;
    systemHealth: ProviderHealthStatus;
  };
}

export interface AdminDiagnosticsSnapshot {
  generatedAt: string;
  queueHealth: QueueHealthSnapshot;
  providers: ProviderHealthRow[];
  cronLastRunAt: string | null;
  cronStale: boolean;
  webhookLastEventAt: string | null;
  webhookStale: boolean;
  dbConnectivityOk: boolean;
  currentTargetState: AdminDiagnosticsInput["currentTargetState"];
  overallHealthy: boolean;
}

const MAX_HEALTHY_CRON_AGE_MS = 26 * 60 * 60 * 1000; // cron is expected daily; alert past ~26h
const MAX_HEALTHY_WEBHOOK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // no inbound events for a week is worth flagging

function isStale(lastSeenAt: string | null, now: Date, maxAgeMs: number): boolean {
  if (!lastSeenAt) return true;
  return now.getTime() - new Date(lastSeenAt).getTime() > maxAgeMs;
}

export function buildAdminDiagnostics(input: AdminDiagnosticsInput): AdminDiagnosticsSnapshot {
  const cronStale = isStale(input.cronLastRunAt, input.now, MAX_HEALTHY_CRON_AGE_MS);
  const webhookStale = isStale(input.webhookLastEventAt, input.now, MAX_HEALTHY_WEBHOOK_AGE_MS);
  const providersHealthy = input.providers.every((p) => p.status === "connected" || p.status === "healthy");

  return {
    generatedAt: input.now.toISOString(),
    queueHealth: input.queueHealth,
    providers: input.providers,
    cronLastRunAt: input.cronLastRunAt,
    cronStale,
    webhookLastEventAt: input.webhookLastEventAt,
    webhookStale,
    dbConnectivityOk: input.dbConnectivityOk,
    currentTargetState: input.currentTargetState,
    overallHealthy: input.queueHealth.healthy && !cronStale && input.dbConnectivityOk && providersHealthy,
  };
}
