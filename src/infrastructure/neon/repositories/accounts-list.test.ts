import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  getDb: () => ({ execute }),
  getNeonSql: vi.fn(),
}));

import { listAccountSummaryRows } from "./accounts";

describe("listAccountSummaryRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue({ rows: [] });
  });

  it("limits workspace rows and restricts child aggregates to the page IDs", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    await listAccountSummaryRows(workspaceId, 26, null);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain("a.workspace_id = $1::uuid");
    expect(query.sql).toContain("LIMIT $2");
    expect(query.sql).toContain("account_id IN (SELECT id FROM account_page)");
    expect(query.sql).toContain("pa.workspace_id = $4::uuid");
    expect(query.sql).not.toMatch(/SELECT\s+\*/i);
    expect(query.params).toEqual([workspaceId, 26, workspaceId, workspaceId]);
  });

  it("maps projected list fields and numeric counts without returning child bundles", async () => {
    execute.mockResolvedValue({ rows: [{
      id: "account-1",
      canonical_name: "Example Pharmacy",
      business_type: "pharmacy",
      province: "Sevilla",
      fit_score: "91.5",
      fit_tier: "high",
      created_at: "2026-01-01 00:00:00.000000+00",
      source_count: "2",
      contact_count: 3,
      analyzed_account_id: "account-1",
      analysis_fit_score: "92",
      analysis_fit_tier: "high",
      confidence: "0.9",
      completed_at: new Date("2026-01-02T00:00:00.000Z"),
      reason_summary: "Strong fit",
    }] });

    const [summary] = await listAccountSummaryRows("workspace-1", 26, null);

    expect(summary).toEqual({
      account: {
        id: "account-1",
        canonicalName: "Example Pharmacy",
        businessType: "pharmacy",
        province: "Sevilla",
        fitScore: 91.5,
        fitTier: "high",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      contactCount: 3,
      sourceCount: 2,
      intelligence: {
        fitScore: 92,
        fitTier: "high",
        confidence: 0.9,
        lastAnalyzedAt: "2026-01-02T00:00:00.000Z",
        reasonSummary: "Strong fit",
      },
    });
    expect(summary).not.toHaveProperty("contacts");
    expect(summary).not.toHaveProperty("contactPoints");
    expect(summary).not.toHaveProperty("sources");
  });

  it("uses the createdAt and ID cursor in stable ascending order", async () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "account-25" };
    await listAccountSummaryRows("workspace-1", 26, cursor);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain("a.created_at > $2::timestamptz");
    expect(query.sql).toContain("a.id > $4::uuid");
    expect(query.sql).toContain("ORDER BY a.created_at ASC, a.id ASC");
    expect(query.params).toEqual([
      "workspace-1",
      cursor.createdAt,
      cursor.createdAt,
      cursor.id,
      26,
      "workspace-1",
      "workspace-1",
    ]);
  });
});