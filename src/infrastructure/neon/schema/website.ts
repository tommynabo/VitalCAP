import { pgTable, text, timestamp, uuid, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { accounts } from "./accounts";

export const websiteEnrichments = pgTable(
  "website_enrichments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    normalizedDomain: text("normalized_domain").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    contentHash: text("content_hash"),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    error: text("error"),
    nextRefreshAt: timestamp("next_refresh_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_website_enrichments_workspace").on(table.workspaceId),
    uniqueIndex("uq_website_enrichments_account_domain").on(table.accountId, table.normalizedDomain),
    index("idx_website_enrichments_account").on(table.accountId),
  ],
);

export const websiteEvidence = pgTable(
  "website_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    normalizedDomain: text("normalized_domain").notNull(),
    sourceUrl: text("source_url").notNull(),
    evidenceType: text("evidence_type").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    snippet: text("snippet"),
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_website_evidence_account").on(table.accountId),
    uniqueIndex("uq_website_evidence_idempotency").on(table.accountId, table.sourceUrl, table.evidenceType, table.normalizedValue),
  ],
);
