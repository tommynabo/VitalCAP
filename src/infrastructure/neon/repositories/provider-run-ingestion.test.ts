import { describe, expect, it } from "vitest";
import { buildProviderRunIngestionAccounting } from "./provider-run-ingestion";

describe("provider run ingestion accounting", () => {
  it("accounts for inserted, duplicate, and unmappable provider items", () => {
    const accounting = buildProviderRunIngestionAccounting({
      itemsReturned: 12,
      candidatesTotal: 8,
      candidatesInserted: 3,
      invalidOrUnmappableItems: 4,
    });

    expect(accounting).toEqual({
      INSERTED_NEW_RAW: 3,
      DUPLICATE_EXISTING_RAW: 5,
      CANONICAL_DEDUPE: 0,
      INVALID_OR_UNMAPPABLE: 4,
      FILTERED_BY_POLICY: 0,
      FAILED_INSERT: 0,
      UNKNOWN: 0,
    });
    expect(Object.values(accounting).reduce((total, count) => total + count, 0)).toBe(12);
  });

  it("rejects an unexplained provider item", () => {
    expect(() => buildProviderRunIngestionAccounting({
      itemsReturned: 12,
      candidatesTotal: 8,
      candidatesInserted: 3,
      invalidOrUnmappableItems: 3,
    })).toThrow("Provider items do not reconcile to ingestion outcomes.");
  });
});