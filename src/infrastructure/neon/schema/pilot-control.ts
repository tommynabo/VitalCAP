import { sql } from "drizzle-orm";
import { boolean, check, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const pilotControl = pgTable("pilot_control", {
  id: boolean("id").primaryKey().default(true),
  status: text("status").notNull().default("disabled"),
  sessionId: uuid("session_id"),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  enabledBy: text("enabled_by"),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  endedBy: text("ended_by"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("pilot_control_singleton_id_true", sql`${table.id} = true`),
  check("pilot_control_status_check", sql`${table.status} IN ('disabled', 'active', 'completed', 'aborted')`),
]);

export const pilotRunPermits = pgTable("pilot_run_permits", {
  runKey: text("run_key").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  runType: text("run_type").notNull(),
  campaignId: uuid("campaign_id"),
  discoveryJobId: uuid("discovery_job_id"),
  providerRunId: uuid("provider_run_id"),
  status: text("status").notNull().default("reserved"),
  chargeCeilingUsd: numeric("charge_ceiling_usd", { mode: "number" }).notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("pilot_run_permits_key_check", sql`${table.runKey} IN ('recovery', '65b9f85d-4c8b-4e52-99fb-217eb3acac1c', '5e109452-2df2-4b1b-9afc-7baa1b67fc42', '47fce807-aac6-4a8a-90f9-6ad3bbbf4ca7', '53f56788-99d9-4d6a-8c71-ab2ffe075d85')`),
  check("pilot_run_permits_type_check", sql`${table.runType} IN ('recovery', 'scoped_smoke')`),
  check("pilot_run_permits_charge_ceiling_check", sql`${table.chargeCeilingUsd} = 0.50`),
  check("pilot_run_permits_status_check", sql`${table.status} IN ('reserved', 'running', 'completed', 'failed')`),
]);