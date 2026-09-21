import { describe, expect, it } from "vitest";
import type { JobRecord } from "@/domain/discovery/types";
import { evaluateQueueHealth } from "@/services/autopilot/queue-health-service";
import { buildAdminDiagnostics } from "./admin-diagnostics";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    campaignId: "camp_1",
    type: "discovery",
    payload: {},
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: "2025-01-01T00:50:00Z",
    updatedAt: "2025-01-01T00:50:00Z",
    ...overrides,
  };
}

const now = new Date("2025-01-01T01:00:00Z");

describe("buildAdminDiagnostics", () => {
  it("reports overall healthy when everything is fresh, connected, and reachable", () => {
    const snapshot = buildAdminDiagnostics({
      queueHealth: evaluateQueueHealth([job()], now),
      now,
      providers: [{ name: "maps", status: "connected", detail: "ok" }],
      cronLastRunAt: "2025-01-01T00:30:00Z",
      webhookLastEventAt: "2025-01-01T00:45:00Z",
      dbConnectivityOk: true,
      currentTargetState: { dailyTarget: 250, readyToday: 120, systemHealth: "healthy" },
    });
    expect(snapshot.overallHealthy).toBe(true);
    expect(snapshot.cronStale).toBe(false);
    expect(snapshot.webhookStale).toBe(false);
  });

  it("flags unhealthy when the cron hasn't run in over a day", () => {
    const snapshot = buildAdminDiagnostics({
      queueHealth: evaluateQueueHealth([job()], now),
      now,
      providers: [{ name: "maps", status: "connected", detail: "ok" }],
      cronLastRunAt: "2024-12-30T00:00:00Z",
      webhookLastEventAt: "2025-01-01T00:45:00Z",
      dbConnectivityOk: true,
      currentTargetState: { dailyTarget: 250, readyToday: 120, systemHealth: "healthy" },
    });
    expect(snapshot.cronStale).toBe(true);
    expect(snapshot.overallHealthy).toBe(false);
  });

  it("flags unhealthy when DB connectivity is down or a provider is degraded", () => {
    const dbDown = buildAdminDiagnostics({
      queueHealth: evaluateQueueHealth([job()], now),
      now,
      providers: [{ name: "maps", status: "connected", detail: "ok" }],
      cronLastRunAt: "2025-01-01T00:30:00Z",
      webhookLastEventAt: "2025-01-01T00:45:00Z",
      dbConnectivityOk: false,
      currentTargetState: { dailyTarget: 250, readyToday: 120, systemHealth: "healthy" },
    });
    expect(dbDown.overallHealthy).toBe(false);

    const providerDegraded = buildAdminDiagnostics({
      queueHealth: evaluateQueueHealth([job()], now),
      now,
      providers: [{ name: "linkedin_owner", status: "paused", detail: "3 consecutive errors" }],
      cronLastRunAt: "2025-01-01T00:30:00Z",
      webhookLastEventAt: "2025-01-01T00:45:00Z",
      dbConnectivityOk: true,
      currentTargetState: { dailyTarget: 250, readyToday: 120, systemHealth: "degraded" },
    });
    expect(providerDegraded.overallHealthy).toBe(false);
  });

  it("surfaces stuck-processing jobs via the underlying queue health snapshot", () => {
    const stuck = job({ status: "processing", lockedAt: "2024-12-31T00:00:00Z" });
    const snapshot = buildAdminDiagnostics({
      queueHealth: evaluateQueueHealth([stuck], now),
      now,
      providers: [{ name: "maps", status: "connected", detail: "ok" }],
      cronLastRunAt: "2025-01-01T00:30:00Z",
      webhookLastEventAt: "2025-01-01T00:45:00Z",
      dbConnectivityOk: true,
      currentTargetState: { dailyTarget: 250, readyToday: 120, systemHealth: "healthy" },
    });
    expect(snapshot.queueHealth.stuckProcessingCount).toBe(1);
    expect(snapshot.overallHealthy).toBe(false);
  });
});
