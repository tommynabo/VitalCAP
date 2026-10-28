import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  getDb: () => ({ execute }),
}));

import { getAutopilotPacingMetrics } from "./autopilot-pacing";
import { computeAutopilotPacing } from "@/services/autopilot/pacing-service";

const dialect = new PgDialect();
const now = new Date("2025-06-15T12:00:00Z");

describe("getAutopilotPacingMetrics raw discovery accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue({ rows: [] });
  });

  it.each([
    {
      name: "does not charge verification requests against discovery capacity",
      providerRuns: [
        { provider: "millionverifier", itemsRequested: 3500 },
        { provider: "apify", itemsRequested: 0 },
        { provider: "serper", itemsRequested: 0 },
      ],
      expectedRawRequested: 0,
      expectedRawRemaining: 1500,
    },
    {
      name: "counts Apify and Serper requests but not verification traffic",
      providerRuns: [
        { provider: "apify", itemsRequested: 400 },
        { provider: "serper", itemsRequested: 200 },
        { provider: "millionverifier", itemsRequested: 3500 },
      ],
      expectedRawRequested: 600,
      expectedRawRemaining: 900,
    },
  ])("$name", async ({ providerRuns, expectedRawRequested, expectedRawRemaining }) => {
    execute.mockImplementation(async (statement) => {
      const query = dialect.sqlToQuery(statement);
      if (query.sql.includes("sum(items_requested)")) {
        const rawTotal = providerRuns
          .filter(({ provider }) => provider === "apify" || provider === "serper")
          .reduce((total, run) => total + run.itemsRequested, 0);
        return { rows: [{ total: rawTotal }] };
      }
      return { rows: [] };
    });

    const metrics = await getAutopilotPacingMetrics("workspace-1", "Europe/Madrid", now);
    const rawRequestQuery = execute.mock.calls
      .map(([statement]) => dialect.sqlToQuery(statement).sql)
      .find((query) => query.includes("sum(items_requested)"));

    expect(rawRequestQuery).toContain("provider IN ('apify', 'serper')");
    expect(metrics.rawRequestedToday).toBe(expectedRawRequested);

    const pacing = computeAutopilotPacing({
      workspaceId: "workspace-1",
      timeZone: "Europe/Madrid",
      targetMetric: "instantly_imported",
      dailyTarget: 250,
      targetAchievedToday: 0,
      instantlyImportedToday: 0,
      rawRequestedToday: metrics.rawRequestedToday,
      rawReturnedToday: 0,
      processingInFlight: 0,
      providerRunsInFlight: 0,
      expectedQualifiedFromInFlight: 0,
      apifySpendToday: 0,
      apifyDailyBudgetRemaining: 10,
      providerHealth: "healthy",
      availableDiscoveryCapacity: true,
      estimatedYield: 0.1,
      yieldSampleSize: 0,
      now,
      operatingStartHour: 7,
      operatingEndHour: 22,
      maxDailyRawRequests: 1500,
    });

    expect(pacing.rawRequestsRemaining).toBe(expectedRawRemaining);
    if (expectedRawRequested === 0) {
      expect(pacing.status).toBe("behind_pace");
      expect(pacing.rawNeededToPlan).toBeGreaterThan(0);
    }
  });

  it("uses distinct account outcomes and requires 20 resolved historical candidates", async () => {
    execute.mockImplementation(async (statement) => {
      const query = dialect.sqlToQuery(statement);
      if (query.sql.includes("WITH qualified AS MATERIALIZED")) {
        return { rows: [{
          qualified_accounts: 12,
          qualified_with_domain: 8,
          qualified_without_valid_email: 9,
          qualified_domain_without_valid_email: 6,
          qualified_recovery_eligible_without_valid_email: 3,
          qualified_terminal_no_match_without_valid_email: 2,
          valid_email_accounts: 3,
          qualified_contactability_backlog: 5,
          resolved_sample: 19,
          confirmed_imports: 10,
          attempted: 4,
          succeeded: 1,
          terminal_no_match: 1,
          transient_failure: 1,
          provider_blocked: 0,
          budget_blocked: 1,
          legacy_unclassified_failure: 0,
          fetch_succeeded: 1,
          fetch_failed: 0,
          email_accounts_created: 1,
          recovery_valid_email_accounts: 1,
          confirmed_imported_accounts: 1,
        }] };
      }
      return { rows: [] };
    });

    const metrics = await getAutopilotPacingMetrics("workspace-1", "Europe/Madrid", now, "instantly-campaign");
    const aggregateSql = execute.mock.calls
      .map(([statement]) => dialect.sqlToQuery(statement).sql)
      .find((query) => query.includes("WITH qualified AS MATERIALIZED"));

    expect(metrics.contactabilityHistoricalSample).toBe(19);
    expect(metrics.contactabilityImportYield).toBe(0);
    expect(metrics.expectedImportsFromContactabilityBacklog).toBe(0);
    expect(metrics.qualifiedContactabilityBacklog).toBe(5);
    expect(metrics.qualifiedAccounts).toBe(12);
    expect(metrics.recoveryOutcomes).toMatchObject({ attempted: 4, succeeded: 1, terminalNoMatch: 1, transientFailure: 1, budgetBlocked: 1 });
    expect(aggregateSql).toContain("c.status = 'active'");
    expect(aggregateSql).toContain("cm.stage <> 'rejected'");
    expect(aggregateSql).toContain("NOT EXISTS (");
    expect(aggregateSql).toContain("has_valid_selected_email");
    expect(aggregateSql).toContain("NOT has_valid_selected_email AND NOT has_valid_email AND NOT confirmed_imported");
    expect(aggregateSql).toContain("(has_domain OR recovery_eligible)");
    expect(aggregateSql).toContain("cm.stage NOT IN ('rejected', 'suppressed')");
    expect(aggregateSql).toContain("conv.state = 'suppressed'");
    expect(aggregateSql).toContain("array_length(regexp_split_to_array(trim(rc.raw_payload #>> '{place,name}')");
    expect(aggregateSql).toContain("cp.source_type IN ('website', 'website_enrichment')");
    expect(aggregateSql).toContain("websiteEmailAttributionComplete");
    expect(aggregateSql).toContain("websiteAttributionCompletedAt");
    expect(aggregateSql).toContain("IN ('', 'succeeded', 'terminal_no_match')");
    expect(aggregateSql).toContain("ili.status = 'instantly_added' AND ili.provider_lead_id IS NOT NULL");
    expect(aggregateSql).toContain("terminal_no_match");
    expect(aggregateSql).toContain("count(DISTINCT account_id)");
  });

  it("uses observed confirmed-account yield at 20 samples and caps it at 30 percent", async () => {
    execute.mockImplementation(async (statement) => {
      const query = dialect.sqlToQuery(statement);
      if (query.sql.includes("WITH qualified AS MATERIALIZED")) {
        return { rows: [{ qualified_contactability_backlog: 100, resolved_sample: 20, confirmed_imports: 12 }] };
      }
      return { rows: [] };
    });

    const metrics = await getAutopilotPacingMetrics("workspace-1", "Europe/Madrid", now, "instantly-campaign");

    expect(metrics.contactabilityHistoricalSample).toBe(20);
    expect(metrics.contactabilityImportYield).toBe(0.3);
    expect(metrics.expectedImportsFromContactabilityBacklog).toBe(30);
  });
});