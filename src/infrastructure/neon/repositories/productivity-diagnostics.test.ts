import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { resetServerEnvCacheForTests } from "@/lib/config/env";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@/infrastructure/neon/db", () => ({ getDb: () => ({ execute: mocks.execute }) }));

import { InstantlyEmailDeliveryProvider } from "@/infrastructure/providers/instantly/provider";
import { getProductivityDiagnostics } from "./productivity-diagnostics";

const dialect = new PgDialect();
const observedQueries: string[] = [];

function configureResults(): void {
  observedQueries.length = 0;
  mocks.execute.mockImplementation(async (statement: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const query = dialect.sqlToQuery(statement).sql;
    observedQueries.push(query);
    if (query.includes("FROM autopilot_settings")) {
      return { rows: [{ timezone: "Europe/Madrid" }] };
    }
    if (query.includes("FROM provider_runs run")) {
      return { rows: [
        {
          provider: "apify",
          operation: "maps_search",
          engine_type: "maps_fast",
          status: "ingested",
          runs: 2,
          items_requested: 100,
          items_returned: 20,
          raw_candidates_linked: 18,
        },
        {
          provider: "apify",
          operation: "maps_search",
          engine_type: "maps_fast",
          status: "failed",
          runs: 1,
          items_requested: 10,
          items_returned: 0,
          raw_candidates_linked: 0,
        },
      ] };
    }
    if (query.includes("today_raw AS")) {
      return { rows: [{
        total: 5,
        oldest_age_minutes: 25,
        with_processing_job: 4,
        without_processing_job: 1,
        pending: 2,
        processing: 1,
        failed: 1,
        dead_letter: 1,
        completed: 1,
        completed_job_but_raw_unprocessed: 1,
        currently_locked: 0,
        lease_expired_retryable: 0,
        stale_locked: 0,
        orphan_count: 2,
      }] };
    }
    if (query.includes("eligible_candidates AS")) {
      return { rows: [{
        eligible_accounts: 3,
        eligible_with_import_row: 1,
        eligible_without_import_row: 2,
        already_represented_accounts_by_email: 1,
        already_represented_by_email: 3,
        eligible_emails_without_import_row: 2,
        eligible_account_statuses: { instantly_added: 1 },
        import_rows_created_today: 1,
        import_rows_created_today_by_status: { instantly_added: 1 },
        circuit_open: false,
      }] };
    }
    throw new Error(`Unexpected diagnostics query: ${query.slice(0, 100)}`);
  });
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("DEV_SEED_MODE", "false");
  vi.stubEnv("INSTANTLY_CAMPAIGN_ID", "055534c5-c3e3-414f-b140-f4770b293c00");
  resetServerEnvCacheForTests();
  vi.clearAllMocks();
  configureResults();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("getProductivityDiagnostics", () => {
  it("aggregates provider status, returned items, and unambiguous raw lineage", async () => {
    const diagnostics = await getProductivityDiagnostics("workspace-1", new Date("2026-10-20T08:00:00.000Z"));

    expect(diagnostics.providerRuns.totalRuns).toBe(3);
    expect(diagnostics.providerRuns.itemsRequested).toBe(110);
    expect(diagnostics.providerRuns.itemsReturned).toBe(20);
    expect(diagnostics.providerRuns.rawCandidatesLinked).toBe(18);
    expect(diagnostics.providerRuns.requestToReturnRate).toBe(0.1818);
    expect(diagnostics.providerRuns.byStatus.ingested).toEqual({ runs: 2, itemsRequested: 100, itemsReturned: 20 });
    expect(diagnostics.providerRuns.byEngine.maps_fast).toEqual({
      runs: 3,
      itemsRequested: 110,
      itemsReturned: 20,
      rawCandidatesLinked: 18,
    });
    expect(diagnostics.providerRuns.successfulItemsRequested).toBe(100);
    expect(diagnostics.providerRuns.successfulItemsReturned).toBe(20);
    expect(diagnostics.providerRuns.successfulRawCandidatesLinked).toBe(18);
    expect(diagnostics.providerRuns.returnedWithoutRawCandidate).toBe(2);
    expect(diagnostics.providerRuns.requestedNotReturned).toBe(90);
    expect(diagnostics.providerRuns.successfulReturnedToRawRate).toBe(0.9);
    expect(diagnostics.providerRuns.rawCandidateDuplicatesSuppressed).toBeNull();
    expect(diagnostics.rootCauses.requestToRaw).toBe("UNKNOWN");
    expect(diagnostics.localDate).toBe("2026-10-20");
  });

  it("classifies unprocessed raws and eligible import rows without returning PII", async () => {
    const diagnostics = await getProductivityDiagnostics("workspace-1", new Date("2026-10-20T08:00:00.000Z"));
    const response = JSON.stringify(diagnostics);

    expect(diagnostics.unprocessedRaw.total).toBe(5);
    expect(diagnostics.unprocessedRaw.withProcessingJob).toBe(4);
    expect(diagnostics.unprocessedRaw.withoutProcessingJob).toBe(1);
    expect(diagnostics.unprocessedRaw.jobStatuses).toEqual({
      pending: 2,
      processing: 1,
      failed: 1,
      dead_letter: 1,
      completed: 1,
    });
    expect(diagnostics.unprocessedRaw.completedJobButRawStillUnprocessed).toBe(1);
    expect(diagnostics.unprocessedRaw.leaseExpiredRetryable).toBe(0);
    expect(diagnostics.unprocessedRaw.orphanProcessingGap).toBe("YES");
    expect(diagnostics.unprocessedRaw.rootCause).toBe("DEADLETTER_BUG");
    expect(diagnostics.instantlyToday.eligibleAccounts).toBe(3);
    expect(diagnostics.instantlyToday.withImportRow).toBe(1);
    expect(diagnostics.instantlyToday.withoutImportRow).toBe(2);
    expect(diagnostics.instantlyToday.alreadyRepresentedByNormalizedEmail).toBe(3);
    expect(diagnostics.instantlyToday.alreadyRepresentedAccountsByNormalizedEmail).toBe(1);
    expect(diagnostics.rootCauses.eligibleToInstantly).toBe("NO_IMPORT_ROW");
    expect(diagnostics.instantlyToday.genuinelyNewEligibleEmailWithoutRepresentation).toBeNull();
    expect(response).not.toContain("normalized_email");
    expect(response).not.toContain("example.com");
    expect(response).not.toContain("Alex Person");
  });

  it("uses SELECT-only SQL and never calls Instantly methods or writes", async () => {
    const planSpy = vi.spyOn(InstantlyEmailDeliveryProvider.prototype, "getPlanUsage");
    const monthlySpy = vi.spyOn(InstantlyEmailDeliveryProvider.prototype, "getMonthlyEmailUsage");
    const addSpy = vi.spyOn(InstantlyEmailDeliveryProvider.prototype, "addLeads");
    const addToCampaignSpy = vi.spyOn(InstantlyEmailDeliveryProvider.prototype, "addLeadToCampaign");

    const diagnostics = await getProductivityDiagnostics("workspace-1", new Date("2026-10-20T08:00:00.000Z"));

    expect(observedQueries).toHaveLength(4);
    for (const query of observedQueries) {
      expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|CALL)\b/i);
    }
    const instantlyQuery = observedQueries.find((query) => query.includes("eligible_candidates AS"));
    expect(instantlyQuery).toContain("imported_email IS DISTINCT FROM normalized_email");
    expect(instantlyQuery).toContain("FROM campaign_provider_mappings mapping");
    expect(planSpy).not.toHaveBeenCalled();
    expect(monthlySpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(addToCampaignSpy).not.toHaveBeenCalled();
    expect(diagnostics.instantlyProvider).toEqual({
      currentLeads: null,
      contactHeadroom: null,
      monthlyEmailsSent: null,
      monthlyEmailHeadroom: null,
      circuitOpen: false,
      liveProviderTelemetryAvailable: false,
    });
    expect(diagnostics.autoSendEnabled).toBe(false);
  });
});