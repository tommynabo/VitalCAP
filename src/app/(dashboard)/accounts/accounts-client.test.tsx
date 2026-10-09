import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsClient } from "./accounts-client";
import type { AccountListPageData } from "@/services/accounts/account-list";

const initialPage: AccountListPageData = {
  items: [{
    account: {
      id: "account-1",
      canonicalName: "Example Pharmacy",
      businessType: "pharmacy",
      province: "Sevilla",
      fitScore: 91,
      fitTier: "high",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    contactCount: 2,
    sourceCount: 3,
    intelligence: {
      fitScore: 92,
      fitTier: "high",
      confidence: 0.9,
      lastAnalyzedAt: "2026-01-02T00:00:00.000Z",
      reasonSummary: "Strong account fit",
    },
  }],
  nextCursor: null,
};

describe("AccountsClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders existing table values from summaries without fetching or rendering details initially", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const markup = renderToStaticMarkup(createElement(AccountsClient, { initialPage }));

    expect(markup).toContain("Example Pharmacy");
    expect(markup).toContain("2");
    expect(markup).toContain("3");
    expect(markup).toContain("Strong account fit");
    expect(markup).not.toContain("Source evidence");
    expect(markup).not.toContain("Contact graph");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders an empty account page safely", () => {
    const markup = renderToStaticMarkup(createElement(AccountsClient, {
      initialPage: { items: [], nextCursor: null },
    }));

    expect(markup).toContain("No accounts found.");
  });
});