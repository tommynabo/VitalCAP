import { pgTable, text, timestamp, uuid, integer, index } from "drizzle-orm/pg-core";

/**
 * Persisted run status for Vercel Cron routes (Prompt 7 §25 — "persisted run
 * status" is an explicit requirement for every cron route). One row per
 * invocation of any `/api/cron/*` route. Deliberately global (not
 * workspace-scoped) since a single cron tick may touch multiple workspaces.
 */
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    route: text("route").notNull(),
    status: text("status").notNull().default("running"),
    itemsProcessed: integer("items_processed").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("idx_cron_runs_route_started").on(table.route, table.startedAt)],
);
