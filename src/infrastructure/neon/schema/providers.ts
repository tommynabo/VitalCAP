import { pgTable, text, timestamp, uuid, numeric, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { campaigns } from "./campaigns";

/**
 * Cost/usage tracking for external providers (Apify runs, Serper queries,
 * email verification batches, LLM calls). Backs the infrastructure/cost
 * dashboard (Prompt 7 §21 cost discipline requirements). Not a 1:1 mirror of
 * any single domain type — aggregates `ProviderUsageStats` shape per event.
 */
export const providerRuns = pgTable(
  "provider_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    requestKey: text("request_key"),
    actorId: text("actor_id"),
    seedId: uuid("seed_id"),
    externalRunId: text("external_run_id"),
    externalDatasetId: text("external_dataset_id"),
    status: text("status").notNull().default("completed"),
    itemsRequested: integer("items_requested").notNull().default(0),
    itemsReturned: integer("items_returned").notNull().default(0),
    costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("idx_provider_runs_workspace").on(table.workspaceId),
    index("idx_provider_runs_campaign").on(table.campaignId),
    index("idx_provider_runs_provider").on(table.provider, table.startedAt),
    uniqueIndex("uq_provider_runs_request_key").on(table.requestKey),
  ],
);
