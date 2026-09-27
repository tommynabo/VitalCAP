import { pgTable, text, timestamp, uuid, integer, numeric, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces";
import { campaigns } from "./campaigns";
import { accounts } from "./accounts";

export const prospectAnalyses = pgTable(
  "prospect_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // pending|completed|failed
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    fitScore: integer("fit_score"),
    fitTier: text("fit_tier"),
    confidence: numeric("confidence", { mode: "number" }),
    qualified: boolean("qualified"),
    needsHumanReview: boolean("needs_human_review"),
    analysisJson: jsonb("analysis_json"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { mode: "number" }),
    providerRequestId: text("provider_request_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_prospect_analyses_logical").on(
      table.campaignId,
      table.accountId,
      table.promptVersion,
      table.inputHash
    ),
    index("idx_prospect_analyses_workspace").on(table.workspaceId),
    index("idx_prospect_analyses_account").on(table.accountId),
    index("idx_prospect_analyses_status").on(table.status),
  ]
);

export const intelligenceJobs = pgTable(
  "intelligence_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_intelligence_jobs_idempotency").on(table.campaignId, table.accountId, table.idempotencyKey),
    // Simplified index for queue fetching:
    index("idx_intelligence_jobs_locked_at").on(table.lockedAt),
  ]
);
