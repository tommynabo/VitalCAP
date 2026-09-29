import { pgTable, text, timestamp, uuid, integer, numeric, jsonb, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces";
import { campaigns } from "./campaigns";
import { accounts } from "./accounts";
import { contactPoints } from "./contacts";

export const complianceDecisions = pgTable(
  "compliance_decisions",
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
    contactPointId: uuid("contact_point_id")
      .notNull()
      .references(() => contactPoints.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    decision: text("decision").notNull(), // allowed, blocked, review_required
    eligibilityBefore: text("eligibility_before"),
    eligibilityAfter: text("eligibility_after").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonText: text("reason_text"),
    policyVersion: text("policy_version").notNull(),
    evidenceJson: jsonb("evidence_json").notNull().default({}),
    decidedBy: text("decided_by").notNull(), // system, operator
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_compliance_decisions_workspace").on(table.workspaceId),
    index("idx_compliance_decisions_campaign").on(table.campaignId),
    index("idx_compliance_decisions_contact_point").on(table.contactPointId),
    index("idx_compliance_decisions_active").on(table.workspaceId).where(sql`superseded_at IS NULL`),
    uniqueIndex("uq_compliance_decisions_current").on(table.campaignId, table.contactPointId, table.channel).where(sql`superseded_at IS NULL`),
  ]
);

export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    providerRawCode: text("provider_raw_code"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    cost: numeric("cost", { mode: "number" }),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    uniqueIndex("uq_email_verifications_cache").on(table.workspaceId, table.normalizedEmail, table.provider),
    index("idx_email_verifications_email").on(table.normalizedEmail),
  ]
);

export const verificationJobs = pgTable(
  "verification_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactPointId: uuid("contact_point_id")
      .notNull()
      .references(() => contactPoints.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    providerRequestId: text("provider_request_id"),
    costUsd: numeric("cost_usd", { mode: "number" }),
    normalizedEmail: text("normalized_email"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_verification_jobs_unique").on(table.contactPointId, table.provider).where(sql`status IN ('pending', 'processing')`),
    index("idx_verification_jobs_unlocked").on(table.workspaceId).where(sql`locked_at IS NULL AND status = 'pending'`),
  ]
);

export const campaignProviderMappings = pgTable(
  "campaign_provider_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCampaignId: text("provider_campaign_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_campaign_provider_mappings_unique").on(table.campaignId, table.provider),
  ]
);
