import { getDb } from "../db";
import { websiteEnrichments, websiteEvidence } from "../schema/website";
import { eq, and, sql } from "drizzle-orm";

export async function getWebsiteEnrichmentStatus(accountId: string, normalizedDomain: string) {
  const records = await getDb()
    .select()
    .from(websiteEnrichments)
    .where(
      and(
        eq(websiteEnrichments.accountId, accountId),
        eq(websiteEnrichments.normalizedDomain, normalizedDomain)
      )
    )
    .limit(1);
  return records[0] ?? null;
}

export async function upsertWebsiteEnrichmentStatus(params: {
  workspaceId: string;
  accountId: string;
  normalizedDomain: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  lastSuccessAt?: Date;
  contentHash?: string | null;
  pagesFetched: number;
  error?: string;
  nextRefreshAt?: Date;
}) {
  await getDb()
    .insert(websiteEnrichments)
    .values(params)
    .onConflictDoUpdate({
      target: [websiteEnrichments.accountId, websiteEnrichments.normalizedDomain],
      set: {
        status: params.status,
        completedAt: params.completedAt,
        lastSuccessAt: params.lastSuccessAt,
        contentHash: params.contentHash,
        pagesFetched: params.pagesFetched,
        error: params.error,
        nextRefreshAt: params.nextRefreshAt,
      },
    });
}

export async function insertWebsiteEvidence(params: {
  workspaceId: string;
  accountId: string;
  normalizedDomain: string;
  sourceUrl: string;
  evidenceType: string;
  value: string;
  normalizedValue: string;
  snippet: string | null;
  contentHash: string;
}) {
  await getDb()
    .insert(websiteEvidence)
    .values(params)
    .onConflictDoNothing({
      target: [websiteEvidence.accountId, websiteEvidence.sourceUrl, websiteEvidence.evidenceType, websiteEvidence.normalizedValue],
    });
}

export async function listUnlinkedWebsiteEmailEvidence(accountId: string, normalizedDomain: string) {
  const result = await getDb().execute(sql`
    SELECT DISTINCT ON (evidence.normalized_value)
      evidence.value,
      evidence.normalized_value,
      evidence.source_url
    FROM website_evidence evidence
    WHERE evidence.account_id = ${accountId}::uuid
      AND evidence.normalized_domain = ${normalizedDomain}
      AND evidence.evidence_type = 'email'
      AND NOT EXISTS (
        SELECT 1 FROM contact_points contact_point
        WHERE contact_point.workspace_id = evidence.workspace_id
          AND contact_point.account_id = evidence.account_id
          AND contact_point.type = 'email'
          AND lower(contact_point.normalized_value) = lower(evidence.normalized_value)
      )
    ORDER BY evidence.normalized_value, evidence.fetched_at, evidence.source_url
  `);

  return (result.rows as Array<{ value: string; normalized_value: string; source_url: string }>).map((row) => ({
    value: row.value,
    normalizedValue: row.normalized_value,
    sourceUrl: row.source_url,
  }));
}
