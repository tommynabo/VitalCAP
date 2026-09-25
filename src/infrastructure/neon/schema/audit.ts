import { pgTable, text, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/** Append-only audit log for workspace-scoped mutating actions. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_log_workspace").on(table.workspaceId, table.createdAt),
    index("idx_audit_log_entity").on(table.entityType, table.entityId),
  ],
);
