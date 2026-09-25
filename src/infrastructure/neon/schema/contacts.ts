import { pgTable, text, timestamp, uuid, numeric, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { accounts } from "./accounts";

/** Neon replacement for `contacts` / `contact_points`. Mirrors `src/domain/contacts/types.ts`. */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    jobTitle: text("job_title"),
    roleType: text("role_type").notNull().default("unknown"),
    isDecisionMaker: boolean("is_decision_maker").notNull().default(false),
    seniority: text("seniority").notNull().default("unknown"),
    linkedinUrl: text("linkedin_url"),
    sourceConfidence: numeric("source_confidence", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_contacts_workspace").on(table.workspaceId),
    index("idx_contacts_account").on(table.accountId),
    index("idx_contacts_account_fullname").on(table.accountId, table.fullName),
  ],
);

export const contactPoints = pgTable(
  "contact_points",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    label: text("label"),
    isGeneric: boolean("is_generic").notNull().default(false),
    isPersonalOrNamed: boolean("is_personal_or_named").notNull().default(false),
    priorityScore: numeric("priority_score", { mode: "number" }).notNull().default(0),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    verificationProvider: text("verification_provider"),
    verificationCheckedAt: timestamp("verification_checked_at", { withTimezone: true }),
    channelEligibility: text("channel_eligibility").notNull().default("unknown"),
    status: text("status").notNull().default("discovered"),
    sourceUrl: text("source_url"),
    sourceType: text("source_type"),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_contact_points_workspace").on(table.workspaceId),
    index("idx_contact_points_account").on(table.accountId),
    index("idx_contact_points_contact").on(table.contactId),
    uniqueIndex("uq_contact_points_normalized_value").on(table.workspaceId, table.type, table.normalizedValue),
  ],
);
