import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, numeric, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { accounts } from "./accounts";
import { providerRuns } from "./providers";

/**
 * Neon replacement for `discovery_jobs` / `processing_jobs` / `raw_candidates`
 * / search seed tracking. Job `status` values match `JobStatus` in
 * `src/domain/discovery/types.ts` (`pending | processing | completed | failed
 * | dead_letter`) — the domain type is the source of truth, not the legacy
 * Supabase SQL's `pending | running | succeeded | failed | dead_letter`.
 */
export const discoveryJobs = pgTable(
  "discovery_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    idempotencyKey: text("idempotency_key"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_discovery_jobs_campaign").on(table.campaignId),
    index("idx_discovery_jobs_dispatch").on(table.status, table.nextAttemptAt),
    uniqueIndex("uq_discovery_jobs_idempotency_inflight")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null and ${table.status} in ('pending', 'processing')`),
  ],
);

export const rawCandidates = pgTable(
  "raw_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    discoveryJobId: uuid("discovery_job_id")
      .notNull()
      .references(() => discoveryJobs.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    engineType: text("engine_type").notNull(),
    sourceExternalId: text("source_external_id"),
    sourceUrl: text("source_url"),
    rawPayload: jsonb("raw_payload").notNull().default({}),
    searchSeedRunId: uuid("search_seed_run_id").references(() => searchSeedRuns.id, { onDelete: "set null" }),
    providerRunId: uuid("provider_run_id").references(() => providerRuns.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    processed: boolean("processed").notNull().default(false),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_raw_candidates_job").on(table.discoveryJobId),
    index("idx_raw_candidates_campaign").on(table.campaignId),
    uniqueIndex("uq_raw_candidates_campaign_engine_external")
      .on(table.campaignId, table.engineType, table.sourceExternalId)
      .where(sql`${table.sourceExternalId} is not null`),
  ],
);

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    idempotencyKey: text("idempotency_key"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_processing_jobs_campaign").on(table.campaignId),
    index("idx_processing_jobs_dispatch").on(table.status, table.nextAttemptAt),
    uniqueIndex("uq_processing_jobs_idempotency_inflight")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null and ${table.status} in ('pending', 'processing')`),
  ],
);

export const searchSeeds = pgTable(
  "search_seeds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    engineType: text("engine_type").notNull(),
    query: text("query").notNull(),
    geography: text("geography").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    totalRaw: integer("total_raw").notNull().default(0),
    totalUnique: integer("total_unique").notNull().default(0),
    totalReady: integer("total_ready").notNull().default(0),
    yieldRate: numeric("yield_rate", { mode: "number" }).notNull().default(0),
    exhaustionScore: numeric("exhaustion_score", { mode: "number" }).notNull().default(0),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
  },
  (table) => [index("idx_search_seeds_campaign").on(table.campaignId)],
);

export const searchSeedRuns = pgTable(
  "search_seed_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seedId: uuid("seed_id")
      .notNull()
      .references(() => searchSeeds.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    rawCount: integer("raw_count").notNull().default(0),
    uniqueCount: integer("unique_count").notNull().default(0),
    readyCount: integer("ready_count").notNull().default(0),
    error: text("error"),
    qualificationFinalizedAt: timestamp("qualification_finalized_at", { withTimezone: true }),
  },
  (table) => [index("idx_search_seed_runs_seed").on(table.seedId)],
);
