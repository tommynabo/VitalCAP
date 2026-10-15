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
});