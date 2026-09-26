import type { Account } from "@/domain/accounts/types";

export type EnrichableAccountField =
  | "phone"
  | "normalizedPhone"
  | "websiteUrl"
  | "normalizedDomain"
  | "googlePlaceId"
  | "mapsUrl"
  | "addressLine"
  | "normalizedAddress"
  | "city"
  | "province"
  | "postalCode"
  | "latitude"
  | "longitude"
  | "rating"
  | "reviewCount"
  | "countryCode";

export type IncomingAccountFields = Pick<Account, EnrichableAccountField>;

/** Fills only absent account facts; conflicting evidence remains in account_sources. */
export function mergeMissingAccountFields(
  existing: Pick<Account, EnrichableAccountField>,
  incoming: IncomingAccountFields,
): Partial<IncomingAccountFields> {
  const updates: Partial<IncomingAccountFields> = {};
  for (const field of Object.keys(incoming) as EnrichableAccountField[]) {
    const value = incoming[field];
    if (existing[field] === null && value !== null) Object.assign(updates, { [field]: value });
  }
  return updates;
}
