/**
 * Domain types for the `accounts` entity (Prompt 1 §1.1) and its evidence
 * (`account_sources`). Pure types only — no framework or infrastructure
 * imports. Persistence lands in Phase 1 via an infrastructure adapter that
 * implements the repository interfaces declared here.
 */

export type BusinessType =
  | "pharmacy"
  | "parapharmacy"
  | "herbal_shop"
  | "sports_nutrition_store"
  | "supplement_store"
  | "other_retail";

export type AccountStatus =
  | "discovered"
  | "normalized"
  | "deduped"
  | "country_verified"
  | "enriched"
  | "qualified"
  | "contactable"
  | "outreach_ready"
  | "rejected_country"
  | "rejected_icp"
  | "duplicate_merged"
  | "needs_review"
  | "no_contact_found"
  | "archived";

export type FitTier = "high" | "medium" | "low" | "unscored";

export interface Account {
  id: string;
  workspaceId: string;
  canonicalName: string;
  normalizedName: string;
  businessType: BusinessType;
  countryCode: "ES";
  region: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  addressLine: string | null;
  normalizedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  normalizedPhone: string | null;
  websiteUrl: string | null;
  normalizedDomain: string | null;
  googlePlaceId: string | null;
  mapsUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  fitScore: number | null;
  fitTier: FitTier;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export type AccountSourceType =
  | "maps_fast"
  | "maps_deep"
  | "google_serp"
  | "linkedin_owner"
  | "hybrid_fill"
  | "manual";

export interface AccountSource {
  id: string;
  accountId: string;
  sourceType: AccountSourceType;
  sourceProvider: string;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  rawSnapshot: Record<string, unknown>;
  discoveredAt: string;
}
