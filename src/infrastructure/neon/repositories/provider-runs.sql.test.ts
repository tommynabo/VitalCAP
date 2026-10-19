import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildApifyPollingDuePredicate, buildReserveApifyProviderRunQuery, buildReserveSerperProviderRunQuery, getApifyReservationFailureDetails, getSafePostgresErrorCode } from "./provider-runs";

const dialect = new PgDialect();

describe("Apify provider run reservation SQL", () => {
  it("retains raw, spend, manual reconciliation, and idempotency guards for recovery probes", () => {
    const query = dialect.sqlToQuery(buildReserveApifyProviderRunQuery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      campaignId: "00000000-0000-0000-0000-000000000002",
      operation: "maps_search",
      requestKey: "apify:stable-key",
      seedId: "00000000-0000-0000-0000-000000000003",
      itemsRequested: 10,
      recoveryProbe: true,
    }, 1500, 15, new Date("2026-10-11T00:00:00.000Z"), 0.05));

    expect(query.sql).toContain("status = 'manual_reconciliation_required'");
    expect(query.sql).toContain("safety.unreconciled_count = 0");
    expect(query.sql).toContain("safety.requested_today +");
    expect(query.sql).toContain("safety.additional_raw_requests <=");
    expect(query.sql).toContain("run.provider IN ('apify', 'serper')");
    expect(query.sql).toContain("<=");
    expect(query.sql).toContain("safety.cost_today +");
    expect(query.sql).toContain("safety.recovery_probe_count = 0");
    expect(query.sql).toContain("ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING");
    expect(query.params).toContain(1500);
    expect(query.params).toContain(15);
  });

  it("applies the same global cap to Serper and replaces its discovery-job reservation", () => {
    const query = dialect.sqlToQuery(buildReserveSerperProviderRunQuery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      campaignId: "00000000-0000-0000-0000-000000000002",
      requestKey: "serper:stable-key",
      seedId: "00000000-0000-0000-0000-000000000003",
      itemsRequested: 10,
      costUsd: 0.01,
      metadata: { engineType: "google_serp", discoveryJobId: "00000000-0000-0000-0000-000000000004" },
    }, 1523, new Date("2026-10-19T12:00:00.000Z")));

    expect(query.sql).toContain("safety.committed_raw_requests + safety.additional_raw_requests <=");
    expect(query.sql).toContain("provider_requests_by_discovery_job run");
    expect(query.sql).toContain("WHERE run.discovery_job_id = job.id::text");
    expect(query.sql).toContain("ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING");
    expect(query.params).toContain(1523);
    expect(query.params).toContain("00000000-0000-0000-0000-000000000004");
  });

  it("marks a legacy configuration failure only when a recovery reservation is inserted", () => {
    const query = dialect.sqlToQuery(buildReserveApifyProviderRunQuery({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      campaignId: "00000000-0000-0000-0000-000000000002",
      operation: "maps_search",
      requestKey: "apify:legacy-recovery",
      seedId: "00000000-0000-0000-0000-000000000003",
      itemsRequested: 10,
      recoveryProbe: true,
      metadata: { configurationFingerprint: "safe-config-fingerprint" },
    }, 1500, 15, new Date("2026-10-11T00:00:00.000Z"), 0.05));

    expect(query.sql).toContain("legacy_configuration_failure_marked AS");
    expect(query.sql).toContain("candidate.metadata->>'failureKind' = 'configuration'");
    expect(query.sql).toContain("EXISTS (SELECT 1 FROM inserted)");
    expect(query.sql).toMatch(/jsonb_build_object\('configurationFingerprint', \$\d+::text\)/);
    expect(query.sql).toMatch(/AND \$\d+::text IS NOT NULL/);
    expect(query.params.filter((parameter) => parameter === "safe-config-fingerprint")).toHaveLength(2);
    expect(query.params).toContain("safe-config-fingerprint");
  });

  it("does not poll an existing provider run before its typed retry cooldown is due", () => {
    const query = dialect.sqlToQuery(buildApifyPollingDuePredicate(new Date("2026-10-11T18:00:00.000Z")));

    expect(query.sql).toContain("metadata->>'pollRetryAt' IS NULL");
    expect(query.sql).toContain("<=");
    expect(query.params).toContain("2026-10-11T18:00:00.000Z");
  });

  it("returns only safe reservation failure details instead of the underlying SQL error", () => {
    const error = Object.assign(new Error("Failed query: SELECT 'sensitive seed geography'"), {
      reservationFailureKind: "SQL_OR_UNKNOWN_RESERVATION_FAILURE" as const,
      reservationErrorClass: "NeonDbError",
    });

    const details = getApifyReservationFailureDetails(error);

    expect(details).toEqual({
      errorClass: "NeonDbError",
      safeErrorMessage: "Provider-run reservation failed before its outcome could be resolved.",
      failureKind: "SQL_OR_UNKNOWN_RESERVATION_FAILURE",
    });
    expect(JSON.stringify(details)).not.toContain("sensitive seed geography");
  });

  it("includes only a valid PostgreSQL SQLSTATE in safe reservation failure details", () => {
    const validCode = Object.assign(new Error("Provider-run reservation query failed."), {
      reservationFailureKind: "SQL_OR_UNKNOWN_RESERVATION_FAILURE" as const,
      reservationErrorCode: "42P10",
    });
    const invalidCode = Object.assign(new Error("Provider-run reservation query failed."), {
      reservationFailureKind: "SQL_OR_UNKNOWN_RESERVATION_FAILURE" as const,
      reservationErrorCode: "password=not-safe",
    });

    expect(getApifyReservationFailureDetails(validCode)?.safeErrorMessage).toContain("SQLSTATE 42P10");
    expect(getApifyReservationFailureDetails(invalidCode)?.safeErrorMessage).not.toContain("password");
  });

  it("extracts a PostgreSQL SQLSTATE from the top-level error", () => {
    expect(getSafePostgresErrorCode(Object.assign(new Error("raw query details"), { code: "42P10" }))).toBe("42P10");
  });

  it("extracts a PostgreSQL SQLSTATE from one and two cause levels", () => {
    const oneCause = new Error("wrapper", { cause: Object.assign(new Error("nested raw query"), { code: "42P18" }) });
    const twoCauses = new Error("outer", {
      cause: new Error("middle", { cause: Object.assign(new Error("deep raw query"), { code: "22P02" }) }),
    });

    expect(getSafePostgresErrorCode(oneCause)).toBe("42P18");
    expect(getSafePostgresErrorCode(twoCauses)).toBe("22P02");
  });

  it("ignores invalid SQLSTATEs, non-Error objects, and errors deeper than three levels", () => {
    const invalidCode = Object.assign(new Error("wrapper"), { code: "42p10" });
    const fourthLevel = Object.assign(new Error("too deep"), { code: "22P02" });
    const tooDeep = new Error("root", {
      cause: new Error("second", { cause: new Error("third", { cause: fourthLevel }) }),
    });

    expect(getSafePostgresErrorCode(invalidCode)).toBeUndefined();
    expect(getSafePostgresErrorCode({ code: "42P10" })).toBeUndefined();
    expect(getSafePostgresErrorCode(tooDeep)).toBeUndefined();
  });

  it("handles cyclic causes without exposing raw error messages", () => {
    const root = new Error("raw query, parameters, and connection details");
    const child = new Error("nested raw details", { cause: root });
    Object.assign(root, { cause: child });

    const code = getSafePostgresErrorCode(root);
    const details = getApifyReservationFailureDetails(Object.assign(root, {
      reservationFailureKind: "SQL_OR_UNKNOWN_RESERVATION_FAILURE" as const,
      reservationErrorCode: code,
    }));

    expect(code).toBeUndefined();
    expect(details?.safeErrorMessage).not.toContain("raw");
    expect(JSON.stringify(details)).not.toContain("connection details");
  });
});