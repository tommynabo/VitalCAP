import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getDb: vi.fn(),
  requireWorkspaceOwner: vi.fn(),
  ledgerRecorded: false,
  ledgerHash: null as string | null,
  columns: [] as Array<Record<string, unknown>>,
  primaryKeyColumns: [] as Array<Record<string, unknown>>,
  ledgerColumns: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("?"), values }),
}));
vi.mock("@/infrastructure/neon/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/infrastructure/providers/instantly/inbox-provider", () => ({ InstantlyInboxProvider: class {} }));
vi.mock("@/infrastructure/neon/repositories/instantly-inbox-reconciliation", () => ({
  getInstantlyInboxCampaignDiscoveryCounts: vi.fn(),
  listConfiguredInstantlyCampaigns: vi.fn(),
}));
vi.mock("@/infrastructure/jobs/runners/instantly-inbox-reconcile-runner", () => ({ runInstantlyInboxReconcileTick: vi.fn() }));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv: vi.fn() }));
vi.mock("@/lib/auth/workspace", () => ({
  UnauthorizedError: class extends Error {},
  requireWorkspaceOwner: mocks.requireWorkspaceOwner,
}));

const { PUT } = await import("./route");

function sqlText(query: { text?: string }) {
  return query.text ?? "";
}

function validColumns() {
  return [
    { column_name: "provider_campaign_id", data_type: "text", is_nullable: "NO", column_default: null, ordinal_position: 1 },
    { column_name: "checkpoint_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null, ordinal_position: 2 },
    { column_name: "window_started_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null, ordinal_position: 3 },
    { column_name: "next_starting_after", data_type: "text", is_nullable: "YES", column_default: null, ordinal_position: 4 },
    { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()", ordinal_position: 5 },
  ];
}

describe("PUT /api/admin/instantly-inbox-reconcile migration ledger action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ledgerRecorded = false;
    mocks.ledgerHash = null;
    mocks.columns = validColumns();
    mocks.primaryKeyColumns = [{ column_name: "provider_campaign_id" }];
    mocks.ledgerColumns = [{ column_name: "id" }, { column_name: "filename" }, { column_name: "hash" }, { column_name: "applied_at" }];
    mocks.requireWorkspaceOwner.mockResolvedValue({ workspaceId: "workspace-1" });
    mocks.execute.mockImplementation(async (query: { text: string; values: unknown[] }) => {
      const text = sqlText(query);
      if (text.includes("to_regclass")) {
        return { rows: [{ reconcile_table: "instantly_inbox_reconcile_state", migration_ledger: "vitalcap_migrations" }] };
      }
      if (text.includes("information_schema.columns") && text.includes("instantly_inbox_reconcile_state")) return { rows: mocks.columns };
      if (text.includes("table_constraints")) return { rows: mocks.primaryKeyColumns };
      if (text.includes("information_schema.columns") && text.includes("vitalcap_migrations")) return { rows: mocks.ledgerColumns };
      if (text.includes("SELECT filename, hash")) {
        return { rows: mocks.ledgerRecorded ? [{ filename: "0021_instantly_inbox_reconcile.sql", hash: mocks.ledgerHash }] : [] };
      }
      if (text.includes("INSERT INTO vitalcap_migrations")) {
        mocks.ledgerRecorded = true;
        mocks.ledgerHash = String(query.values[1]);
        return { rows: [] };
      }
      return { rows: [] };
    });
    mocks.getDb.mockReturnValue({ execute: mocks.execute });
  });

  it("does not record a migration when the existing table shape differs", async () => {
    mocks.columns[4] = { ...mocks.columns[4], column_default: "CURRENT_TIMESTAMP" };

    const response = await PUT(new Request("https://example.test/api/admin/instantly-inbox-reconcile", {
      method: "PUT",
      body: JSON.stringify({ action: "record-0021-ledger-only" }),
    }));

    expect(response.status).toBe(409);
    expect(mocks.execute).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("INSERT INTO vitalcap_migrations") }));
  });

  it("records only the repository hash when the table is verified and the ledger row is missing", async () => {
    const response = await PUT(new Request("https://example.test/api/admin/instantly-inbox-reconcile", {
      method: "PUT",
      body: JSON.stringify({ action: "record-0021-ledger-only" }),
    }));
    const result = await response.json();

    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(mocks.ledgerRecorded).toBe(true);
    expect(mocks.ledgerHash).toBe("761f461eff8ea2bdec46fdd1f7c2699a2b26117d540f226b84ebc60e6d1404d0");
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("INSERT INTO vitalcap_migrations (id, filename, hash, applied_at)") }));
    expect(result).toMatchObject({ migrationLedgerRecordedAfter: true, migrationLedgerHashMatches: true, futureDbMigrate0021Safe: true });
  });
});
