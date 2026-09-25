import { pgTable, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Neon-native replacement for Supabase's `workspaces` / `workspace_members`
 * (Prompt 7 §5–§7). `workspace_members.user_id` no longer references
 * Supabase's `auth.users` — it stores the Neon Auth (Managed Better Auth)
 * user id, which lives in the `neon_auth` schema managed by Neon itself and
 * is therefore referenced here as an unconstrained `text` column (Neon Auth
 * is a separate managed service; we do not own or migrate its schema).
 */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Neon Auth (`neon_auth.user`) user id — not a foreign key across services. */
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_workspace_members_workspace_user").on(table.workspaceId, table.userId),
    index("idx_workspace_members_user").on(table.userId),
  ],
);
