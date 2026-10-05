import { sql, type SQLWrapper } from "drizzle-orm";
import { ACTUAL_PRIOR_COLD_OUTREACH_STATES } from "@/services/deduplication/outreach-dedup";
import { getDb } from "../db";

export interface ActualOutreachScope {
  workspaceId: SQLWrapper | string;
  accountId: SQLWrapper | string;
  contactPointId?: SQLWrapper | string;
  normalizedEmail?: SQLWrapper | string;
}

export function actualPriorColdOutreachSql(scope: ActualOutreachScope) {
  const actualStates = sql.raw(ACTUAL_PRIOR_COLD_OUTREACH_STATES.map((state) => `'${state}'`).join(", "));
  const workspaceId = typeof scope.workspaceId === "string" ? sql.raw(scope.workspaceId) : scope.workspaceId;
  const accountId = typeof scope.accountId === "string" ? sql.raw(scope.accountId) : scope.accountId;
  const contactPointId = typeof scope.contactPointId === "string" ? sql.raw(scope.contactPointId) : scope.contactPointId;
  const normalizedEmail = typeof scope.normalizedEmail === "string" ? sql.raw(scope.normalizedEmail) : scope.normalizedEmail;
  const contactScope = contactPointId
    ? sql`OR oq.contact_point_id = ${contactPointId}`
    : sql``;
  const emailScope = normalizedEmail
    ? sql`OR (
        NULLIF(TRIM(${normalizedEmail}), '') IS NOT NULL
        AND LOWER(TRIM(oq.normalized_email)) = LOWER(TRIM(${normalizedEmail}))
      )`
    : sql``;

  return sql`EXISTS (
    SELECT 1
    FROM outreach_queue oq
    WHERE oq.workspace_id = ${workspaceId}
      AND oq.channel = 'email'
      AND (
        oq.account_id = ${accountId}
        ${contactScope}
        ${emailScope}
      )
      AND (
        (oq.delivery_mode = 'live' AND oq.state IN (${actualStates}))
        OR EXISTS (
          SELECT 1 FROM outreach_events oe
          WHERE oe.outreach_queue_item_id = oq.id
            AND oe.state IN (${actualStates})
        )
      )
  )`;
}

export async function hasActualPriorColdOutreach(input: {
  workspaceId: string;
  accountId: string;
  contactPointId?: string;
  normalizedEmail?: string;
}): Promise<boolean> {
  const db = getDb();
  const predicate = actualPriorColdOutreachSql({
    workspaceId: sql`${input.workspaceId}`,
    accountId: sql`${input.accountId}`,
    contactPointId: input.contactPointId ? sql`${input.contactPointId}` : undefined,
    normalizedEmail: input.normalizedEmail ? sql`${input.normalizedEmail}` : undefined,
  });
  const result = await db.execute(sql`SELECT ${predicate} AS has_actual_prior_outreach`);
  return Boolean((result.rows[0] as { has_actual_prior_outreach?: boolean } | undefined)?.has_actual_prior_outreach);
}