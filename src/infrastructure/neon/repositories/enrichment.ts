import { getDb } from "../db";
import { websiteEnrichments, websiteEvidence } from "../schema/website";
import { eq, and } from "drizzle-orm";

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
