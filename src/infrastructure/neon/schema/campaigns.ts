import { pgTable, text, timestamp, uuid, integer, numeric, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { accounts } from "./accounts";
import { contacts, contactPoints } from "./contacts";

/** Neon replacement for `offers` / `campaigns` / `campaign_memberships`. Mirrors `src/domain/campaigns/types.ts`. */
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    company: text("company").notNull(),
    description: text("description").notNull().default(""),
    primaryCta: text("primary_cta").notNull(),
    bookingUrl: text("booking_url").notNull(),
    approvedCommercialFacts: jsonb("approved_commercial_facts").notNull().default({}),
    approvedProductFacts: jsonb("approved_product_facts").notNull().default({}),
    approvedClaims: jsonb("approved_claims").notNull().default([]),
    forbiddenClaims: jsonb("forbidden_claims").notNull().default([]),
    faq: jsonb("faq").notNull().default([]),
    objectionGuidance: jsonb("objection_guidance").notNull().default({}),
    toneConfig: jsonb("tone_config").notNull().default({}),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_offers_workspace").on(table.workspaceId)],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    countryCode: text("country_code").notNull().default("ES"),
    engineType: text("engine_type").notNull(),
    engineConfig: jsonb("engine_config").notNull().default({}),
    dailySoftTarget: integer("daily_soft_target").notNull().default(50),
    minimumFitScore: numeric("minimum_fit_score", { mode: "number" }),
    outreachProfileId: uuid("outreach_profile_id"),
    autopilotEnabled: boolean("autopilot_enabled").notNull().default(false),
    desiredChannelMix: jsonb("desired_channel_mix").notNull().default({ email: 50, sms: 50 }),
    timeZone: text("time_zone").notNull().default("Europe/Madrid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_campaigns_workspace").on(table.workspaceId),
    index("idx_campaigns_status").on(table.workspaceId, table.status),
  ],
);

export const campaignMemberships = pgTable(
  "campaign_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    selectedContactPointId: uuid("selected_contact_point_id").references(() => contactPoints.id, { onDelete: "set null" }),
    stage: text("stage").notNull().default("discovered"),
    rejectionReason: text("rejection_reason"),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    contactedAt: timestamp("contacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_campaign_memberships_campaign").on(table.campaignId),
    index("idx_campaign_memberships_account").on(table.accountId),
    index("idx_campaign_memberships_stage").on(table.campaignId, table.stage),
    uniqueIndex("uq_campaign_memberships_campaign_account").on(table.campaignId, table.accountId),
  ],
);
