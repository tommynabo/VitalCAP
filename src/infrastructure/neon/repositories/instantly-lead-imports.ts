import { createInstantlyImportIdempotencyKey } from "@/domain/providers/instantly-idempotency";
import { getDb, schema } from "@/infrastructure/neon/db";
import { sql } from "drizzle-orm";

export interface InstantLeadImportCandidate {
  workspaceId: string;
  accountId: string;
  sourceCampaignId: string;
  contactId: string | null;
  contactPointId: string;
  providerCampaignId: string;
  normalizedEmail: string;
}

export async function enqueueInstantlyLeadImport(candidate: InstantLeadImportCandidate): Promise<boolean> {
  const db = getDb();
  const normalizedEmail = candidate.normalizedEmail.trim().toLowerCase();
  const [inserted] = await db.insert(schema.instantlyLeadImports).values({
    ...candidate,
    normalizedEmail,
    idempotencyKey: createInstantlyImportIdempotencyKey({
      workspaceId: candidate.workspaceId,
      accountId: candidate.accountId,
      contactPointId: candidate.contactPointId,
      providerCampaignId: candidate.providerCampaignId,
    }),
  }).onConflictDoNothing().returning({ id: schema.instantlyLeadImports.id });
  return Boolean(inserted);
}

export async function claimInstantlyLeadImports(limit: number, now: Date): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const lockExpiry = new Date(now.getTime() - 15 * 60_000);
  const claimed = await db.execute(sql`
    WITH available AS (
      SELECT id
      FROM instantly_lead_imports
      WHERE status IN ('eligible', 'failed', 'deferred', 'instantly_queued')
        AND (locked_at IS NULL OR locked_at < ${lockExpiry.toISOString()})
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
        AND attempt_count < max_attempts
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE instantly_lead_imports AS imports
    SET status = 'instantly_queued',
        locked_at = ${now.toISOString()},
        attempt_count = imports.attempt_count + 1,
        updated_at = ${now.toISOString()}
    FROM available
    WHERE imports.id = available.id
    RETURNING imports.*
  `);
  return claimed.rows as Record<string, unknown>[];
}

export async function updateInstantlyLeadImport(
  id: string,
  update: {
    status: "instantly_added" | "skipped_existing" | "failed" | "deferred";
    now: Date;
    nextAttemptAt?: Date | null;
    lastError?: string | null;
    providerLeadId?: string | null;
  },
): Promise<void> {
  const db = getDb();
  await db.update(schema.instantlyLeadImports).set({
    status: update.status,
    lockedAt: null,
    nextAttemptAt: update.nextAttemptAt ?? null,
    lastError: update.lastError?.slice(0, 1000) ?? null,
    providerLeadId: update.providerLeadId ?? null,
    uploadedAt: update.status === "instantly_added" ? update.now : undefined,
    updatedAt: update.now,
  }).where(sql`${schema.instantlyLeadImports.id} = ${id}`);
}

export async function getInstantlyLeadImportCounts(): Promise<Record<string, number>> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT status, COUNT(*)::int AS count
    FROM instantly_lead_imports
    GROUP BY status
  `);
  return Object.fromEntries(result.rows.map((row) => [String(row.status), Number(row.count)]));
}

export async function acquireInstantlyImportLock(
  providerCampaignId: string,
  lockToken: string,
  now: Date,
  leaseUntil: Date,
): Promise<boolean> {
  const db = getDb();
  const result = await db.execute(sql`
    INSERT INTO instantly_import_locks (provider_campaign_id, lock_token, locked_until, updated_at)
    VALUES (${providerCampaignId}, ${lockToken}, ${leaseUntil.toISOString()}, ${now.toISOString()})
    ON CONFLICT (provider_campaign_id) DO UPDATE
    SET lock_token = EXCLUDED.lock_token,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at
    WHERE instantly_import_locks.locked_until <= ${now.toISOString()}
    RETURNING provider_campaign_id
  `);
  return result.rows.length > 0;
}

export async function releaseInstantlyImportLock(providerCampaignId: string, lockToken: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    DELETE FROM instantly_import_locks
    WHERE provider_campaign_id = ${providerCampaignId} AND lock_token = ${lockToken}
  `);
}