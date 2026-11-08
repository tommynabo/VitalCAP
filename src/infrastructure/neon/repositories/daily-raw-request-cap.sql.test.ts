import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getNeonSql: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb, getNeonSql: mocks.getNeonSql }));

import { buildDailyRawRequestCapSnapshot, buildDailyRawRequestCapSnapshotQuery, buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery, executeUnderGlobalDailyRawCapLock } from "./daily-raw-request-cap";
import { buildReserveApifyProviderRunQuery } from "./provider-runs";

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
    expect(query.sql).toContain("input.payload->>'origin' = 'recovery_probe'");
    expect(query.sql).toContain("existing.status IN ('pending', 'processing')");
    expect(query.params).toContain(1523);
    expect(query.params.some((parameter) => typeof parameter === "string"
      && parameter.includes('"origin":"recovery_probe"')
      && parameter.includes('"priority":0'))).toBe(true);
  });

  it("checks completed and dead-letter recovery jobs by their exact recovery identity", () => {
    const query = dialect.sqlToQuery(buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery([{
      campaignId: "campaign-recovery",
      type: "run_engine_batch",
      payload: { engineType: "maps_fast", desiredRawCount: 10, origin: "recovery_probe" },
      idempotencyKey: "apify-recovery-probe:workspace:campaign:credential:failure-epoch",
      desiredRawCount: 10,
    }], 1523, now));

    expect(query.sql).toContain("existing.idempotency_key = input.idempotency_key");
    expect(query.sql).toMatch(/input\.payload->>'origin' = 'recovery_probe'[\s\S]*OR existing\.status IN \('pending', 'processing'\)/);
  });

  it("enforces an additional atomic daily cap across the four rollout campaigns", () => {
    const campaignIds = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
      "00000000-0000-0000-0000-000000000004",
    ];
    const query = dialect.sqlToQuery(buildEnqueueDiscoveryOrdersWithinDailyRawCapQuery([{
      campaignId: campaignIds[0]!,
      type: "run_engine_batch",
      payload: { engineType: "maps_fast", desiredRawCount: 4, origin: "normal" },
      idempotencyKey: "rollout-probe",
      desiredRawCount: 4,
    }], 9000, now, { campaignIds, cap: 4 }));

    expect(query.sql).toContain("scoped_provider_commitment");
    expect(query.sql).toContain("scoped_queued_commitment");
    expect(query.sql).toContain("scoped_daily_commitment.committed_raw_requests");
    expect(query.sql).toContain("run.campaign_id IN (");
    expect(query.sql).toContain("job.campaign_id IN (");
    expect(query.sql).toContain("eligible.campaign_id IN (");
    expect(query.params).toContain(4);
    expect(query.params).toContain(9000);
    for (const campaignId of campaignIds) expect(query.params).toContain(campaignId);
  });

  it("serializes concurrent Apify reservation statements behind the transaction-scoped global lock", async () => {
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

    const snapshot = {
      actualSpendUsd: 4.7,
      reservedSpendUsd: 0.1,
      committedSpendUsd: 4.8,
      runCount: 1,
      runIds: ["observed-run"],
      dayStart: "2026-10-19T22:00:00.000Z",
      dayEnd: "2026-10-20T22:00:00.000Z",
    };
    const reservationQueries = ["concurrent-a", "concurrent-b"].map((requestKey) => buildReserveApifyProviderRunQuery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      campaignId: "00000000-0000-0000-0000-000000000002",
      operation: "maps_search",
      requestKey,
      seedId: "00000000-0000-0000-0000-000000000003",
      itemsRequested: 10,
      accountCostSnapshot: snapshot,
      metadata: {},
    }, 1500, 5, new Date(snapshot.dayStart), 0.5, now));

    const results = await Promise.all(reservationQueries.map(executeUnderGlobalDailyRawCapLock));

    expect(results).toEqual([[{ reserved: 1 }], [{ reserved: 1 }]]);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    for (const [queries] of mocks.transaction.mock.calls as [Array<{ kind: string; query: string }> ][]) {
      expect(queries).toHaveLength(2);
      expect(queries[0]?.query).toContain("pg_advisory_xact_lock");
      expect(queries[1]?.kind).toBe("query");
      expect(queries[1]?.query).toContain("safety.reservation_cost_usd > 0");
      expect(queries[1]?.query).toContain("reconciled_cost_safety.accounted_actual_spend + reconciled_cost_safety.account_reserved_spend");
    }
  });
});
