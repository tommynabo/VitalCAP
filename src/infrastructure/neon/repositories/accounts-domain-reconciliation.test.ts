import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountIdentitySignals } from "@/services/deduplication/account-dedup";
import { accounts, accountSources } from "../schema/accounts";
import { contactPoints } from "../schema/contacts";
import { campaignMemberships } from "../schema/campaigns";
import { findCandidateAccountMatches, isNormalizedDomainUniqueViolation, omitIdentityValuesOwnedByOtherAccounts, resolveCanonicalAccount, selectCanonicalAccountMatch, type InsertAccountInput } from "./accounts";

const neonMocks = vi.hoisted(() => ({ transaction: vi.fn(), getDb: vi.fn() }));

vi.mock("../db", () => ({
  getDb: neonMocks.getDb,
  getNeonSql: () => Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
    { transaction: neonMocks.transaction },
  ),
}));

const incoming = {
  normalizedName: "farmacia central",
  googlePlaceId: "place-a",
  normalizedDomain: "farmacia-central.es",
};

const domainOwner: AccountIdentitySignals = {
  accountId: "account-b",
  normalizedName: "farmacia central",
  googlePlaceId: null,
  normalizedDomain: "farmacia-central.es",
};

const placeIdMatch: AccountIdentitySignals = {
  accountId: "account-a",
  normalizedName: "farmacia central",
  googlePlaceId: "place-a",
  normalizedDomain: null,
};

const accountInput: InsertAccountInput = {
  workspaceId: "workspace-id",
  canonicalName: "Farmacia Central",
  normalizedName: "farmacia central",
  businessType: "pharmacy",
  countryCode: "ES",
  region: null,
  province: null,
  city: null,
  postalCode: null,
  addressLine: null,
  normalizedAddress: null,
  latitude: null,
  longitude: null,
  phone: null,
  normalizedPhone: null,
  websiteUrl: null,
  normalizedDomain: "farmacia-central.es",
  googlePlaceId: "place-a",
  mapsUrl: null,
  rating: null,
  reviewCount: null,
  status: "discovered",
};

beforeEach(() => {
  neonMocks.transaction.mockReset();
  neonMocks.getDb.mockReset();
});

describe("canonical account domain reconciliation", () => {
  it("selects the exact domain owner when Place ID resolves to another row", () => {
    expect(selectCanonicalAccountMatch(incoming, [placeIdMatch, domainOwner])).toEqual({
      kind: "existingAccount",
      existingAccountId: "account-b",
      matchedSignal: "normalized_domain",
    });
  });

  it("orders the database resolver's exact domain match before its Place ID match", async () => {
    neonMocks.transaction.mockResolvedValueOnce([[], [{
      resolution: "existingAccount",
      account_id: "account-b",
      matched_signal: "normalized_domain",
    }]]);

    await expect(resolveCanonicalAccount("workspace-id", incoming, accountInput)).resolves.toEqual({
      kind: "existingAccount",
      existingAccountId: "account-b",
      matchedSignal: "normalized_domain",
    });

    const query = neonMocks.transaction.mock.calls[0]?.[0]?.[1] as { strings: string[] };
    const text = query.strings.join("?");
    expect(text.indexOf("THEN 'normalized_domain'")).toBeLessThan(text.indexOf("THEN 'google_place_id'"));
    expect(text.indexOf("WHEN matched_signal = 'normalized_domain'")).toBeLessThan(text.indexOf("WHEN matched_signal = 'google_place_id'"));
  });

  it("orders exact identity candidates before fuzzy candidates in the bounded lookup", async () => {
    const builder = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{
        id: "account-b",
        normalizedName: "farmacia central",
        googlePlaceId: null,
        normalizedDomain: "farmacia-central.es",
        normalizedPhone: null,
        postalCode: null,
        normalizedAddress: null,
        latitude: null,
        longitude: null,
      }]),
    };
    neonMocks.getDb.mockReturnValue(builder);

    await expect(findCandidateAccountMatches("workspace-id", incoming)).resolves.toMatchObject([
      { accountId: "account-b", normalizedDomain: "farmacia-central.es" },
    ]);

    const order = builder.orderBy.mock.calls[0]?.[0] as SQL;
    const orderSql = new PgDialect().sqlToQuery(order).sql;
    expect(orderSql.indexOf("normalized_domain")).toBeLessThan(orderSql.indexOf("google_place_id"));
    expect(builder.limit).toHaveBeenCalledWith(20);
  });

  it("flags impossible duplicate domain owners instead of choosing one", () => {
    expect(selectCanonicalAccountMatch(incoming, [domainOwner, { ...domainOwner, accountId: "account-c" }])).toEqual({
      kind: "needsReview",
      matchedAccountId: null,
      matchedSignal: "ambiguous_normalized_domain",
    });
  });

  it("retains existing strong-signal priority when there is no domain owner", () => {
    expect(selectCanonicalAccountMatch(incoming, [placeIdMatch])).toEqual({
      kind: "existingAccount",
      existingAccountId: "account-a",
      matchedSignal: "google_place_id",
    });
  });

  it("does not copy a unique identity value already owned by another account", () => {
    expect(omitIdentityValuesOwnedByOtherAccounts("account-b", {
      normalizedDomain: "farmacia-central.es",
      googlePlaceId: "place-a",
      city: "Madrid",
    }, [placeIdMatch, domainOwner])).toEqual({
      normalizedDomain: "farmacia-central.es",
      city: "Madrid",
    });
  });

  it("recognizes only the normalized-domain unique violation, including wrapped errors", () => {
    expect(isNormalizedDomainUniqueViolation({ cause: { code: "23505", constraint_name: "uq_accounts_normalized_domain" } })).toBe(true);
    expect(isNormalizedDomainUniqueViolation({ code: "23505", constraint: "uq_accounts_place_id" })).toBe(false);
    expect(isNormalizedDomainUniqueViolation({ code: "23503", constraint: "uq_accounts_normalized_domain" })).toBe(false);
  });

  it("preserves the workspace-scoped normalized-domain unique constraint", () => {
    const domainIndex = getTableConfig(accounts).indexes.find((index) => index.config.name === "uq_accounts_normalized_domain");

    expect(domainIndex?.config.unique).toBe(true);
    expect(domainIndex?.config.columns.map((column) => "name" in column ? column.name : null)).toEqual(["workspace_id", "normalized_domain"]);
  });

  it("preserves idempotency constraints for sources, contact points, and campaign memberships", () => {
    const uniqueIndexNames = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table).indexes.filter((index) => index.config.unique).map((index) => index.config.name);

    expect(uniqueIndexNames(accountSources)).toContain("uq_account_sources_identity");
    expect(uniqueIndexNames(contactPoints)).toContain("uq_contact_points_account_normalized_value");
    expect(uniqueIndexNames(campaignMemberships)).toContain("uq_campaign_memberships_campaign_account");
  });
});