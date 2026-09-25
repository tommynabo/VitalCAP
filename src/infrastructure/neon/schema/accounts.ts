import { pgTable, text, timestamp, uuid, doublePrecision, numeric, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Neon replacement for `accounts` / `account_sources` / `account_merge_records`
 * (Prompt 7 §5). Column shape mirrors `src/domain/accounts/types.ts` exactly
 * (source of truth), not the legacy Supabase SQL — this closes any drift
 * before real persistence goes live.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    businessType: text("business_type").notNull(),
    countryCode: text("country_code").notNull(),
    region: text("region"),
    province: text("province"),
    city: text("city"),
    postalCode: text("postal_code"),
    addressLine: text("address_line"),
    normalizedAddress: text("normalized_address"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    phone: text("phone"),
    normalizedPhone: text("normalized_phone"),
    websiteUrl: text("website_url"),
    normalizedDomain: text("normalized_domain"),
    googlePlaceId: text("google_place_id"),
    mapsUrl: text("maps_url"),
    rating: numeric("rating", { mode: "number" }),
    reviewCount: integer("review_count"),
    fitScore: numeric("fit_score", { mode: "number" }),
    fitTier: text("fit_tier").notNull().default("unscored"),
    status: text("status").notNull().default("discovered"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_accounts_workspace").on(table.workspaceId),
    index("idx_accounts_status").on(table.workspaceId, table.status),
    uniqueIndex("uq_accounts_place_id").on(table.workspaceId, table.googlePlaceId),
    uniqueIndex("uq_accounts_normalized_domain").on(table.workspaceId, table.normalizedDomain),
    uniqueIndex("uq_accounts_normalized_phone").on(table.workspaceId, table.normalizedPhone),
    index("idx_accounts_name_postal").on(table.workspaceId, table.normalizedName, table.postalCode),
    index("idx_accounts_name_address").on(table.workspaceId, table.normalizedName, table.normalizedAddress),
  ],
);

export const accountSources = pgTable(
  "account_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceProvider: text("source_provider").notNull(),
    sourceExternalId: text("source_external_id"),
    sourceUrl: text("source_url"),
    rawSnapshot: jsonb("raw_snapshot").notNull().default({}),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_account_sources_account").on(table.accountId)],
);

export const accountMergeRecords = pgTable(
  "account_merge_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    survivingAccountId: uuid("surviving_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    mergedAccountId: uuid("merged_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    matchedSignal: text("matched_signal").notNull(),
    confidence: numeric("confidence", { mode: "number" }).notNull(),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_account_merge_records_surviving").on(table.survivingAccountId),
    index("idx_account_merge_records_merged").on(table.mergedAccountId),
  ],
);
