import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_LIST_PAGE_SIZE,
  loadAccountListPage,
  mergeAccountListPageData,
  type AccountListSummary,
} from "./account-list";

function makeSummary(index: number): AccountListSummary {
  return {
    account: {
      id: `account-${index}`,
      canonicalName: `Account ${index}`,
      businessType: "pharmacy",
      province: "Sevilla",
      fitScore: 90,
      fitTier: "high",
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    },
    contactCount: 2,
    sourceCount: 1,
    intelligence: {
      fitScore: 90,
      fitTier: "high",
      confidence: 0.9,
      lastAnalyzedAt: "2026-01-01T00:00:00.000Z",
      reasonSummary: "Good account fit",
    },
  };
}

describe("account list pages", () => {
  it("requests one cursor sentinel and returns only list-card summary fields", async () => {
    const rows = Array.from({ length: ACCOUNT_LIST_PAGE_SIZE + 1 }, (_, index) => makeSummary(index));
    const listAccountSummaries = vi.fn(async () => rows);
    const page = await loadAccountListPage({ listAccountSummaries });

    expect(listAccountSummaries).toHaveBeenCalledWith(26, null);
    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toEqual(rows[0]);
    expect(page.items[0]).not.toHaveProperty("contacts");
    expect(page.items[0]).not.toHaveProperty("contactPoints");
    expect(page.items[0]).not.toHaveProperty("sources");
    expect(page.nextCursor).toEqual({ createdAt: rows[24]!.account.createdAt, id: "account-24" });
  });

  it("forwards the cursor and safely ends when no further accounts exist", async () => {
    const cursor = { createdAt: "2026-01-25T00:00:00.000Z", id: "account-24" };
    const listAccountSummaries = vi.fn(async () => [makeSummary(25)]);
    const page = await loadAccountListPage({ listAccountSummaries }, cursor);

    expect(listAccountSummaries).toHaveBeenCalledWith(26, cursor);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("returns a safe empty page", async () => {
    const listAccountSummaries = vi.fn(async () => []);
    const page = await loadAccountListPage({ listAccountSummaries });

    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("appends cursor pages without duplicating accounts", () => {
    const merged = mergeAccountListPageData(
      { items: [makeSummary(1)], nextCursor: { createdAt: "2026-01-02T00:00:00.000Z", id: "account-1" } },
      { items: [makeSummary(1), makeSummary(2)], nextCursor: null },
    );

    expect(merged.items.map(({ account }) => account.id)).toEqual(["account-1", "account-2"]);
    expect(merged.nextCursor).toBeNull();
  });
});