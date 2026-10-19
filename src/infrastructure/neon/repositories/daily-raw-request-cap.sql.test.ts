import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getNeonSql: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb, getNeonSql: mocks.getNeonSql }));

import { buildDailyRawRequestCapSnapshot, buildDailyRawRequestCapSnapshotQuery, buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery, executeUnderGlobalDailyRawCapLock } from "./daily-raw-request-cap";

const dialect = new PgDialect();
const now = new Date("2026-10-19T12:00:00.000Z");

describe("global daily raw request cap SQL", () => {
  it("reports unclamped utilization and overshoot while blocking new work", () => {
    expect(buildDailyRawRequestCapSnapshot(1523, 2878, 2857, 21)).toEqual({
      cap: 1523,
      committedRawRequests: 2878,
      providerReservedRawRequests: 2857,
      queuedRawRequests: 21,
      remainingRawRequests: 0,
      utilization: 2878 / 1523,
      blocked: true,
      overshootRawRequests: 1355,
      blockedReason: "daily_raw_request_cap_reached",
    });
  });

  it("counts provider reservations in each workspace's local day and carries active runs", () => {
    const query = dialect.sqlToQuery(buildDailyRawRequestCapSnapshotQuery(now));

    expect(query.sql).toContain("AT TIME ZONE COALESCE(settings.timezone, 'Europe/Madrid')");
    expect(query.sql).toContain("run.provider IN ('apify', 'serper')");
    expect(query.sql).toContain("run.status IN ('starting', 'queued', 'running', 'succeeded', 'ingesting')");
    expect(query.sql).toContain("run.metadata->>'discoveryJobId'");
    expect(query.sql).toContain("job.status IN ('pending', 'processing')");
    expect(query.sql).toContain("job.payload->>'desiredRawCount'");
    expect(query.sql).toContain("GREATEST(");
    expect(query.params).toContain(now.toISOString());
  });

  it("allocates recovery probes first and clips inserted discovery reservations to global headroom", () => {
    const query = dialect.sqlToQuery(buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery([
      {
        campaignId: "campaign-normal",
        type: "run_engine_batch",
        payload: { engineType: "google_serp", desiredRawCount: 100, origin: "normal" },
        idempotencyKey: "normal-order",
        desiredRawCount: 100,
      },
      {
        campaignId: "campaign-recovery",
        type: "run_engine_batch",
        payload: { engineType: "maps_fast", desiredRawCount: 10, origin: "recovery_probe" },
        idempotencyKey: "recovery-order",
        desiredRawCount: 10,
      },
    ], 1523, now));

    expect(query.sql).toContain("ORDER BY eligible.priority, eligible.order_index");
    expect(query.sql).toContain("priority integer");
    expect(query.sql).toContain("jsonb_set(allocated.payload, '{desiredRawCount}'");
    expect(query.sql).toContain("ON CONFLICT DO NOTHING");
    expect(query.sql).toContain("WHERE allocated.reserved_raw_count > 0");
    expect(query.params).toContain(1523);
    expect(query.params.some((parameter) => typeof parameter === "string"
      && parameter.includes('"origin":"recovery_probe"')
      && parameter.includes('"priority":0'))).toBe(true);
  });

  it("uses one transaction-scoped global advisory lock before reading and reserving capacity", async () => {
    const neon = Object.assign(
      (strings: TemplateStringsArray, ...parameters: unknown[]) => ({
        kind: "template",
        query: Array.from(strings).join("$param"),
        parameters,
      }),
      {
        query: vi.fn((query: string, parameters: unknown[]) => ({ kind: "query", query, parameters })),
        transaction: mocks.transaction,
      },
    );
    mocks.getNeonSql.mockReturnValue(neon);
    mocks.transaction.mockResolvedValue([[], [{ reserved: 1 }]]);

    const rows = await executeUnderGlobalDailyRawCapLock(buildDailyRawRequestCapSnapshotQuery(now));

    expect(rows).toEqual([{ reserved: 1 }]);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const [queries] = mocks.transaction.mock.calls[0] as [Array<{ kind: string; query: string }>];
    expect(queries).toHaveLength(2);
    expect(queries[0]?.query).toContain("pg_advisory_xact_lock");
    expect(queries[1]?.kind).toBe("query");
  });
});
