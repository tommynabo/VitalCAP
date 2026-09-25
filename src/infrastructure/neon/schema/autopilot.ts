import { pgTable, text, timestamp, uuid, numeric, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Audit log of `QuotaRebalancer` decisions (Prompt 2 §2.11 /
 * `src/domain/autopilot/types.ts` `RebalanceDecision`). Written by the
 * autopilot cron job (Gate E), read here for the dashboard.
 */
export const rebalanceDecisions = pgTable(
  "rebalance_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromEngine: text("from_engine"),
    toEngine: text("to_engine").notNull(),
    amount: numeric("amount", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_rebalance_decisions_workspace").on(table.workspaceId, table.createdAt)],
);
