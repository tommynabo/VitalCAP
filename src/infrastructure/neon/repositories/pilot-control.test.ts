import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../db", () => ({ getDb: () => ({ execute: mocks.execute }) }));

import { acquirePilotRunPermit, isPilotRunPermitActive, restoreNormalOperation, startIsolatedPilot } from "./pilot-control";

const dialect = new PgDialect();

describe("pilot control repository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("atomically reserves each unique permit key and audits its actor", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ run_key: "recovery" }] });

    await expect(acquirePilotRunPermit({
      runKey: "recovery",
      runType: "recovery",
      sessionId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
      campaignId: "00000000-0000-0000-0000-000000000003",
      discoveryJobId: "00000000-0000-0000-0000-000000000004",
      actorUserId: "admin-1",
    })).resolves.toBe(true);

    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0]![0]);
    expect(query.sql).toContain("ON CONFLICT (run_key) DO NOTHING");
    expect(query.sql).toContain("INSERT INTO audit_log");
    expect(query.sql).toContain("settings.emergency_stopped = false");
    expect(query.params).toContain("admin-1");
  });

  it("invalidates an otherwise matching permit when emergency stop is active", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    await expect(isPilotRunPermitActive({
      runKey: "recovery",
      sessionId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
      campaignId: "00000000-0000-0000-0000-000000000003",
      discoveryJobId: "00000000-0000-0000-0000-000000000004",
    })).resolves.toBe(false);

    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0]![0]);
    expect(query.sql).toContain("settings.emergency_stopped = false");
    expect(query.sql).toContain("permit.discovery_job_id =");
  });

  it("counts only permits from the session being restored", async () => {
    mocks.execute.mockResolvedValue({ rows: [{
      status: "aborted",
      session_id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      enabled_at: null,
      ended_at: null,
    }] });

    await restoreNormalOperation({ workspaceId: "00000000-0000-0000-0000-000000000002", actorUserId: "admin-1" });

    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0]![0]);
    expect(query.sql).toContain("WHERE session_id = pilot_control.session_id");
    expect(query.sql).toContain("WHERE session_id = updated.session_id");
  });

  it("enables only the exact four Draft/off campaigns without rewriting pending work", async () => {
    mocks.execute.mockResolvedValue({ rows: [{
      status: "active",
      session_id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      enabled_at: null,
      ended_at: null,
    }] });

    await startIsolatedPilot({ workspaceId: "00000000-0000-0000-0000-000000000002", actorUserId: "admin-1" });

    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0]![0]);
    expect(query.sql).toContain("(SELECT count FROM valid_campaigns) = 4");
    expect(query.sql).toContain("status = 'draft'");
    expect(query.sql).toContain("autopilot_enabled = false");
    expect(query.sql).not.toContain("DELETE FROM discovery_jobs");
    expect(query.sql).not.toContain("UPDATE discovery_jobs");
    expect(query.params).toEqual(expect.arrayContaining([
      "65b9f85d-4c8b-4e52-99fb-217eb3acac1c",
      "5e109452-2df2-4b1b-9afc-7baa1b67fc42",
      "47fce807-aac6-4a8a-90f9-6ad3bbbf4ca7",
      "53f56788-99d9-4d6a-8c71-ab2ffe075d85",
    ]));
  });
});