import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, numeric, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { accounts } from "./accounts";
import { contacts, contactPoints } from "./contacts";
import { workspaces } from "./workspaces";

/**
 * Neon replacement for `outreach_queue` / `outreach_events` / sending
 * infrastructure / suppression / dead letters. Mirrors
 * `src/domain/outreach/types.ts`.
 */
export const outreachQueue = pgTable(
  "outreach_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("send_outreach"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    idempotencyKey: text("idempotency_key"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    lastError: text("last_error"),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    contactPointId: uuid("contact_point_id")
      .notNull()
      .references(() => contactPoints.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    priority: numeric("priority", { mode: "number" }).notNull().default(0),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    state: text("state").notNull().default("queued"),
    deliveryMode: text("delivery_mode").notNull().default("dry_run"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_outreach_queue_campaign").on(table.campaignId),
    index("idx_outreach_queue_dispatch").on(table.status, table.nextAttemptAt),
    index("idx_outreach_queue_account").on(table.accountId),
    index("idx_outreach_queue_dedup_key").on(table.contactPointId, table.campaignId, table.channel),
    uniqueIndex("uq_outreach_queue_idempotency_inflight")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null and ${table.status} in ('pending', 'processing')`),
  ],
);

export const outreachEvents = pgTable(
  "outreach_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outreachQueueItemId: uuid("outreach_queue_item_id")
      .notNull()
      .references(() => outreachQueue.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    providerEventId: text("provider_event_id"),
    payloadHash: text("payload_hash"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_outreach_events_queue_item").on(table.outreachQueueItemId),
    index("idx_outreach_events_state").on(table.state),
    // Idempotency: a provider event id can only be recorded once (webhook replay guard, Prompt 7 §22).
    // Postgres unique indexes allow multiple NULLs, so events without a provider id are unaffected.
    uniqueIndex("uq_outreach_events_provider_event_id").on(table.providerEventId),
  ],
);

export const deadLetterJobs = pgTable(
  "dead_letter_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceTable: text("source_table").notNull(),
    sourceJobId: uuid("source_job_id").notNull(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    payload: jsonb("payload").notNull().default({}),
    attemptCount: integer("attempt_count").notNull(),
    lastError: text("last_error").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_dead_letter_jobs_source_job").on(table.sourceTable, table.sourceJobId),
    index("idx_dead_letter_jobs_source").on(table.sourceTable, table.sourceJobId),
    index("idx_dead_letter_jobs_created_at").on(table.createdAt),
  ],
);

export const sendingDomains = pgTable("sending_domains", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  status: text("status").notNull().default("missing_configuration"),
  warmupStatus: text("warmup_status").notNull().default("unknown"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sendingDomainId: uuid("sending_domain_id")
      .notNull()
      .references(() => sendingDomains.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    dailyCapacity: integer("daily_capacity").notNull().default(0),
    sentToday: integer("sent_today").notNull().default(0),
    bounceRate: numeric("bounce_rate", { mode: "number" }).notNull().default(0),
    replyRate: numeric("reply_rate", { mode: "number" }).notNull().default(0),
    healthScore: numeric("health_score", { mode: "number" }).notNull().default(0),
    pausedReason: text("paused_reason"),
  },
  (table) => [index("idx_mailboxes_sending_domain").on(table.sendingDomainId)],
);

export const suppressionEntries = pgTable(
  "suppression_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactPointId: uuid("contact_point_id").references(() => contactPoints.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_suppression_entries_workspace").on(table.workspaceId),
    index("idx_suppression_entries_contact_point").on(table.contactPointId),
    index("idx_suppression_entries_account").on(table.accountId),
  ],
);
