import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WATCHDOG_QUEUE_PAUSE_REASON } from "@/services/autopilot/watchdog-pause-policy";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getWatchdogWorkspaceSignals: vi.fn(),
}));

vi.mock("../../neon/db", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("../../neon/repositories/watchdog-signals", () => ({
  getWatchdogWorkspaceSignals: mocks.getWatchdogWorkspaceSignals,
}));
vi.mock("../../neon/repositories/workspace", () => ({ listWorkspaceIds: vi.fn() }));
vi.mock("../../neon/repositories/job-queue", () => ({
  deadLetterExpiredJobs: vi.fn(),
  requeueStaleLockedJobs: vi.fn(),
  STALE_JOB_LOCK_THRESHOLD_MS: 15 * 60_000,
}));

import { refreshWatchdogPauseForWorkspace } from "./watchdog-runner";

const dialect = new PgDialect();
const workspaceId = "workspace-1";

describe("refreshWatchdogPauseForWorkspace", () => {
  let persisted: { systemPaused: boolean; systemPauseReason: string | null; systemPausedAt: Date | null };

  beforeEach(() => {
    vi.clearAllMocks();
    persisted = {
      systemPaused: true,
      systemPauseReason: WATCHDOG_QUEUE_PAUSE_REASON,
      systemPausedAt: new Date("2025-01-01T01:00:00Z"),
    };
    mocks.getWatchdogWorkspaceSignals.mockResolvedValue([{
      workspaceId,
      emergencyStopped: false,
      systemPaused: persisted.systemPaused,
      systemPauseReason: persisted.systemPauseReason,
      systemPausedAt: persisted.systemPausedAt,
      oldDueDiscovery: 4,
      recoverableOldDueDiscovery: 4,
      deferredDiscovery: 0,
      oldProcessing: 0,
      staleDiscoveryLocks: 0,
      staleProcessingLocks: 0,
      manualReconciliations: 0,
      processingPending: 0,
      processingCompletedRecent: 0,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 0,
      oldestDueDiscoveryAgeMinutes: 45,
      oldestProcessingAgeMinutes: null,
      recoveryProbeDiscoveryCount: 0,
    }]);
    mocks.execute.mockImplementation(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      if (query.sql.includes("UPDATE autopilot_settings")) {
        const [systemPaused, systemPauseReason, systemPausedAt, updatedWorkspaceId] = query.params;
        if (updatedWorkspaceId === workspaceId) {
          persisted = {
            systemPaused: systemPaused as boolean,
            systemPauseReason: systemPauseReason as string | null,
            systemPausedAt: systemPausedAt ? new Date(String(systemPausedAt)) : null,
          };
        }
      }
      return { rows: [] };
    });
  });

  it("persists a cleared watchdog-owned pause for a bounded recoverable queue", async () => {
    await refreshWatchdogPauseForWorkspace(workspaceId);

    expect(persisted).toEqual({ systemPaused: false, systemPauseReason: null, systemPausedAt: null });
    const [statement] = mocks.execute.mock.calls[0] ?? [];
    expect(statement).toBeDefined();
    const update = dialect.sqlToQuery(statement as SQL);
    expect(update.sql).toContain("UPDATE autopilot_settings");
    expect(update.params).toEqual([false, null, null, workspaceId]);
  });
});