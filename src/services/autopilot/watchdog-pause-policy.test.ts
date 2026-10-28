import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { PROVIDER_DEFERRED_JOB_ERROR_PREFIX } from "@/domain/discovery/types";
import { buildWatchdogWorkspaceSignalsQuery } from "@/infrastructure/neon/repositories/watchdog-signals";
import {
  evaluateWatchdogPause,
  getAdaptiveProcessingMaxJobs,
  getDiscoveryBackpressureMultiplier,
  getProcessingHealthState,
  getWatchdogPausePredicates,
  WATCHDOG_QUEUE_PAUSE_REASON,
  WATCHDOG_RECONCILIATION_PAUSE_REASON,
} from "./watchdog-pause-policy";

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

  it("does not pause for old processing jobs while the queue is actively draining", () => {
    const signals = {
      ...clearSignals,
      oldProcessing: 2,
      processingPending: 170,
      processingCompletedRecent: 24,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 24,
    };

    expect(getProcessingHealthState(signals)).toBe("healthy_draining");
    expect(evaluateWatchdogPause(clearState, signals, now)).toEqual(clearState);
  });

  it("pauses when repeated processing failures or timeouts indicate a stall", () => {
    expect(evaluateWatchdogPause(clearState, {
      ...clearSignals,
      processingPending: 80,
      processingCompletedRecent: 8,
      processingFailedRecent: 3,
    }, now).systemPauseReason).toBe(WATCHDOG_QUEUE_PAUSE_REASON);
    expect(evaluateWatchdogPause(clearState, {
      ...clearSignals,
      processingPending: 80,
      processingCompletedRecent: 8,
      processingTimedOutRecent: 2,
    }, now).systemPauseReason).toBe(WATCHDOG_QUEUE_PAUSE_REASON);
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

  it("automatically resumes a watchdog-owned pause when an old queue is healthy and draining", () => {
    const paused = {
      systemPaused: true,
      systemPauseReason: WATCHDOG_QUEUE_PAUSE_REASON,
      systemPausedAt: new Date("2025-01-01T01:00:00Z"),
    };
    const state = evaluateWatchdogPause(paused, {
      ...clearSignals,
      oldProcessing: 1,
      processingPending: 90,
      processingCompletedRecent: 12,
      processingFailedRecent: 0,
      processingTimedOutRecent: 0,
      processingEnqueuedRecent: 10,
    }, now);

    expect(state).toEqual(clearState);
  });

  it("preserves pauses owned by another safety control", () => {
    const manualPause = { systemPaused: true, systemPauseReason: "operator_hold", systemPausedAt: now };

    expect(evaluateWatchdogPause(manualPause, clearSignals, now)).toEqual(manualPause);
  });
});

describe("adaptive processing capacity and discovery backpressure", () => {
  it("uses the base processing limit for a small backlog", () => {
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 50, processingCompletedRecent: 4 })).toBe(8);
  });

  it("increases bounded capacity for healthy moderate and large backlogs", () => {
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 51, processingCompletedRecent: 4 })).toBe(12);
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 170, processingCompletedRecent: 8 })).toBe(16);
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 1000, processingCompletedRecent: 8 })).toBeLessThanOrEqual(16);
  });

  it("keeps worker capacity conservative when errors, timeouts, or stale locks exist", () => {
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 170, processingCompletedRecent: 8, processingFailedRecent: 1 })).toBe(8);
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 170, processingCompletedRecent: 8, processingTimedOutRecent: 1 })).toBe(8);
    expect(getAdaptiveProcessingMaxJobs({ ...clearSignals, processingPending: 170, processingCompletedRecent: 8, staleProcessingLocks: 1 })).toBe(8);
  });

  it("keeps worker capacity at baseline when queue growth is uncontrolled", () => {
    expect(getAdaptiveProcessingMaxJobs({
      ...clearSignals,
      processingPending: 170,
      processingCompletedRecent: 20,
      processingEnqueuedRecent: 60,
    })).toBe(8);
  });

  it("reduces discovery as backlog grows and stops it when processing is stalled", () => {
    expect(getDiscoveryBackpressureMultiplier({ ...clearSignals, processingPending: 50 })).toBe(1);
    expect(getDiscoveryBackpressureMultiplier({ ...clearSignals, processingPending: 75 })).toBe(0.75);
    expect(getDiscoveryBackpressureMultiplier({ ...clearSignals, processingPending: 120 })).toBe(0.5);
    expect(getDiscoveryBackpressureMultiplier({ ...clearSignals, processingPending: 170, processingCompletedRecent: 8 })).toBe(0.25);
    expect(getDiscoveryBackpressureMultiplier({ ...clearSignals, processingPending: 170, oldProcessing: 1 })).toBe(0);
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
      "processing_stalled",
      "stale_discovery_lock",
      "stale_processing_lock",
    ]);
  });
});