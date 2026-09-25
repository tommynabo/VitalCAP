import { pgTable, text, timestamp, uuid, numeric, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { accounts } from "./accounts";
import { contacts } from "./contacts";
import { campaigns, offers } from "./campaigns";

/**
 * Neon replacement for `conversations` / `conversation_messages` /
 * `setter_drafts` / `setter_feedback` / `meetings`. Mirrors
 * `src/domain/conversations/types.ts` exactly (this is the ADR-019 fix:
 * legacy Supabase SQL was missing `offerId`, `providerThreadId`,
 * `latestIntent`, `channel` on conversations, and several `setter_drafts` /
 * `setter_feedback` fields present in the domain types).
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "restrict" }),
    channel: text("channel").notNull(),
    providerThreadId: text("provider_thread_id"),
    state: text("state").notNull().default("new"),
    latestIntent: text("latest_intent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_conversations_workspace").on(table.workspaceId),
    index("idx_conversations_account").on(table.accountId),
    index("idx_conversations_campaign").on(table.campaignId),
    index("idx_conversations_state").on(table.workspaceId, table.state),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    body: text("body").notNull(),
    channel: text("channel").notNull(),
    providerMessageId: text("provider_message_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_conversation_messages_conversation").on(table.conversationId, table.createdAt)],
);

export const setterDrafts = pgTable(
  "setter_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationMessageId: uuid("conversation_message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    branch: text("branch").notNull(),
    intentSummary: text("intent_summary").notNull(),
    confidence: numeric("confidence", { mode: "number" }).notNull(),
    draft: text("draft").notNull(),
    needsHuman: boolean("needs_human").notNull().default(true),
    reasonForHuman: text("reason_for_human"),
    detectedFactsRequested: jsonb("detected_facts_requested").notNull().default([]),
    riskFlags: jsonb("risk_flags").notNull().default([]),
    suggestedNextAction: text("suggested_next_action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_setter_drafts_conversation_message").on(table.conversationMessageId)],
);

export const setterFeedback = pgTable(
  "setter_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationMessageId: uuid("conversation_message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "cascade" }),
    predictedBranch: text("predicted_branch").notNull(),
    correctedBranch: text("corrected_branch"),
    aiDraft: text("ai_draft").notNull(),
    correctedText: text("corrected_text"),
    decision: text("decision").notNull(),
    reasonCategory: text("reason_category"),
    note: text("note"),
    meetingOutcome: text("meeting_outcome"),
    qualified: boolean("qualified"),
    lostReason: text("lost_reason"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    reviewerId: text("reviewer_id").notNull(),
  },
  (table) => [index("idx_setter_feedback_conversation_message").on(table.conversationMessageId)],
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    bookingUrl: text("booking_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_meetings_conversation").on(table.conversationId)],
);

/**
 * Neon replacement for `src/services/setter/warm-followup-service.ts`'s
 * `WarmFollowupQueueItem` (Prompt 4 §4.12, wired up for real by the Gate E
 * `/api/cron/warm-followup` route). A positive/interested lead that replied
 * but has not booked enters this queue instead of the cold sequence.
 */
export const warmFollowupQueue = pgTable(
  "warm_followup_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_warm_followup_queue_conversation").on(table.conversationId),
    index("idx_warm_followup_queue_dispatch").on(table.status, table.nextFollowupAt),
  ],
);
