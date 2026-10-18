import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { PROVIDER_DEFERRED_JOB_ERROR_PREFIX } from "@/domain/discovery/types";
import { buildWatchdogWorkspaceSignalsQuery } from "@/infrastructure/neon/repositories/watchdog-signals";
import { evaluateWatchdogPause, getWatchdogPausePredicates, WATCHDOG_QUEUE_PAUSE_REASON, WATCHDOG_RECONCILIATION_PAUSE_REASON } from "./watchdog-pause-policy";

const now = new Date("2025-01-01T02:00:00Z");
const dialect = new PgDialect();
const clearState = { systemPaused: false, systemPauseReason: null, systemPausedAt: null };
const clearSignals = {
  oldDueDiscovery: 0,
  deferredDiscovery: 0,
  oldProcessing: 0,
  staleDiscoveryLocks: 0,
  staleProcessingLocks: 0,
  manualReconciliations: 0,
};

describe("evaluateWatchdogPause", () => {
  it("does not workspace-pause for Apify-specific deferred discovery alone", () => {
    const query = dialect.sqlToQuery(buildWatchdogWorkspaceSignalsQuery("workspace-1"));
    const state = evaluateWatchdogPause(clearState, { ...clearSignals, deferredDiscovery: 3 }, now);

    expect(query.params).toContain(PROVIDER_DEFERRED_JOB_ERROR_PREFIX);
    expect(state.systemPaused).toBe(false);
    expect(state.systemPauseReason).toBeNull();
  });

  it("pauses for multiple normal old due discovery jobs", () => {
    const state = evaluateWatchdogPause(clearState, { ...clearSignals, oldDueDiscovery: 2 }, now);

    expect(state.systemPaused).toBe(true);
    expect(state.systemPauseReason).toBe(WATCHDOG_QUEUE_PAUSE_REASON);
  });

  it("does not pause for due recovery probes because the shared old-due SQL excludes them", () => {
    const query = dialect.sqlToQuery(buildWatchdogWorkspaceSignalsQuery("workspace-1"));
    const state = evaluateWatchdogPause(clearState, clearSignals, now);

    expect(query.sql).toContain("COALESCE(dj.payload->>'origin', '') <> 'recovery_probe'");
    expect(query.sql).toContain("LEFT(COALESCE(dj.last_error, '')");
    expect(state.systemPaused).toBe(false);
  });

  it("pauses for old processing jobs", () => {
    const state = evaluateWatchdogPause(clearState, { ...clearSignals, oldProcessing: 2 }, now);

    expect(state.systemPaused).toBe(true);
    expect(state.systemPauseReason).toBe(WATCHDOG_QUEUE_PAUSE_REASON);
  });

  it("pauses for stale discovery locks", () => {
    const state = evaluateWatchdogPause(clearState, { ...clearSignals, staleDiscoveryLocks: 1 }, now);

    expect(state.systemPaused).toBe(true);
    expect(state.systemPauseReason).toBe(WATCHDOG_QUEUE_PAUSE_REASON);
  });

  it("pauses for stale processing locks", () => {
    const state = evaluateWatchdogPause(clearState, { ...clearSignals, staleProcessingLocks: 1 }, now);

    expect(state.systemPaused).toBe(true);
    expect(state.systemPauseReason).toBe(WATCHDOG_QUEUE_PAUSE_REASON);
  });

  it("keeps manual provider reconciliation as a workspace pause", () => {
    const state = evaluateWatchdogPause(clearState, { ...clearSignals, manualReconciliations: 1 }, now);

    expect(state.systemPaused).toBe(true);
    expect(state.systemPauseReason).toBe(WATCHDOG_RECONCILIATION_PAUSE_REASON);
  });

  it("clears a watchdog-owned pause after the triggering condition disappears", () => {
    const paused = {
      systemPaused: true,
      systemPauseReason: WATCHDOG_QUEUE_PAUSE_REASON,
      systemPausedAt: new Date("2025-01-01T01:00:00Z"),
    };
    const state = evaluateWatchdogPause(paused, clearSignals, now);

    expect(state).toEqual({ systemPaused: false, systemPauseReason: null, systemPausedAt: null });
  });

  it("preserves pauses owned by another safety control", () => {
    const manualPause = { systemPaused: true, systemPauseReason: "operator_hold", systemPausedAt: now };

    expect(evaluateWatchdogPause(manualPause, clearSignals, now)).toEqual(manualPause);
  });
});

describe("getWatchdogPausePredicates", () => {
  it("returns every matched queue predicate in stable order and ignores deferred-only jobs", () => {
    expect(getWatchdogPausePredicates({ ...clearSignals, deferredDiscovery: 2 })).toEqual([]);
    expect(getWatchdogPausePredicates({
      ...clearSignals,
      oldDueDiscovery: 1,
      oldProcessing: 2,
      staleDiscoveryLocks: 3,
      staleProcessingLocks: 4,
    })).toEqual([
      "old_due_discovery",
      "old_processing",
      "stale_discovery_lock",
      "stale_processing_lock",
    ]);
  });
});