import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getDb, getNeonSql } from "../db";
import { accounts, accountSources } from "../schema/accounts";
import { contacts, contactPoints } from "../schema/contacts";
import type { Account, AccountSource, AccountStatus, BusinessType } from "@/domain/accounts/types";
import type { Contact, ContactPoint, ContactPointType, VerificationStatus } from "@/domain/contacts/types";
import type { AccountIdentitySignals } from "@/services/deduplication/account-dedup";
import { evaluateAccountDedup } from "@/services/deduplication/account-dedup";
import { deriveEmailChannelEligibility } from "@/services/compliance/email-channel-policy";
import type { SetterQueueAccount } from "@/services/setter/review-queue";
import type { AccountListCursor, AccountListSummary } from "@/services/accounts/account-list";

export interface AccountBundle {
  account: Account;
  sources: AccountSource[];
  contacts: Contact[];
  contactPoints: ContactPoint[];
  intelligence?: AccountIntelligence | null;
}

export interface AccountIntelligence {
  fitScore: number | null;
  fitTier: string | null;
  confidence: number | null;
  lastAnalyzedAt: string | null;
  reasonSummary: string | null;
  positiveSignals: string[];
  negativeSignals: string[];
  missingInformation: string[];
  riskFlags: string[];
  evidence: Array<{ id: string; type: string; value: string; sourceUrl: string | null }>;
}

function safeNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function safeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];
}

function mapIntelligence(row: Record<string, unknown>): AccountIntelligence {
  const analysis = row.analysis_json && typeof row.analysis_json === "object" && !Array.isArray(row.analysis_json)
    ? row.analysis_json as Record<string, unknown>
    : {};
  const evidence = Array.isArray(analysis.evidence)
    ? analysis.evidence.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const fact = item as Record<string, unknown>;
        if (typeof fact.id !== "string" || typeof fact.type !== "string" || typeof fact.value !== "string") return [];
        return [{
          id: fact.id,
          type: fact.type,
          value: fact.value.slice(0, 280),
          sourceUrl: typeof fact.sourceUrl === "string" ? fact.sourceUrl : null,
        }];
      }).slice(0, 12)
    : [];
  const completedAt = row.completed_at instanceof Date
    ? row.completed_at.toISOString()
    : typeof row.completed_at === "string" ? row.completed_at : null;

  return {
    fitScore: safeNumeric(row.fit_score),
    fitTier: typeof row.fit_tier === "string" ? row.fit_tier : null,
    confidence: safeNumeric(row.confidence),
    lastAnalyzedAt: completedAt,
    reasonSummary: typeof analysis.reasonSummary === "string" ? analysis.reasonSummary.slice(0, 280) : null,
    positiveSignals: safeStringList(analysis.positiveSignals),
    negativeSignals: safeStringList(analysis.negativeSignals),
    missingInformation: safeStringList(analysis.missingInformation),
    riskFlags: safeStringList(analysis.riskFlags),
    evidence,
  };
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    canonicalName: row.canonicalName,
    normalizedName: row.normalizedName,
    businessType: row.businessType as Account["businessType"],
    countryCode: row.countryCode,
    region: row.region,
    province: row.province,
    city: row.city,
    postalCode: row.postalCode,
    addressLine: row.addressLine,
    normalizedAddress: row.normalizedAddress,
    latitude: row.latitude,
    longitude: row.longitude,
    phone: row.phone,
    normalizedPhone: row.normalizedPhone,
    websiteUrl: row.websiteUrl,
    normalizedDomain: row.normalizedDomain,
    googlePlaceId: row.googlePlaceId,
    mapsUrl: row.mapsUrl,
    rating: row.rating,
    reviewCount: row.reviewCount,
    fitScore: row.fitScore,
    fitTier: row.fitTier as Account["fitTier"],
    status: row.status as Account["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAccountSource(row: typeof accountSources.$inferSelect): AccountSource {
  return {
    id: row.id,
    accountId: row.accountId,
    sourceType: row.sourceType as AccountSource["sourceType"],
    sourceProvider: row.sourceProvider,
    sourceExternalId: row.sourceExternalId,
    sourceUrl: row.sourceUrl,
    rawSnapshot: row.rawSnapshot as AccountSource["rawSnapshot"],
    discoveredAt: row.discoveredAt.toISOString(),
  };
}

function toContact(row: typeof contacts.$inferSelect): Contact {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: row.fullName,
    jobTitle: row.jobTitle,
    roleType: row.roleType as Contact["roleType"],
    isDecisionMaker: row.isDecisionMaker,
    seniority: row.seniority as Contact["seniority"],
    linkedinUrl: row.linkedinUrl,
    sourceConfidence: row.sourceConfidence,
    status: row.status as Contact["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toContactPoint(row: typeof contactPoints.$inferSelect): ContactPoint {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    contactId: row.contactId,
    type: row.type as ContactPoint["type"],
    value: row.value,
    normalizedValue: row.normalizedValue,
    label: row.label,
    isGeneric: row.isGeneric,
    isPersonalOrNamed: row.isPersonalOrNamed,
    priorityScore: row.priorityScore,
    verificationStatus: row.verificationStatus as ContactPoint["verificationStatus"],
    verificationProvider: row.verificationProvider,
    verificationCheckedAt: row.verificationCheckedAt?.toISOString() ?? null,
    channelEligibility: row.channelEligibility as ContactPoint["channelEligibility"],
    sourceUrl: row.sourceUrl,
    sourceType: row.sourceType,
    lastContactedAt: row.lastContactedAt?.toISOString() ?? null,
    status: row.status as ContactPoint["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Full account/source/contact/contact-point graph for a workspace. Bounded
 * by workspace scope; a future paginated variant should be added if a
 * single workspace ever grows into the tens of thousands of accounts (see
 * `docs/PERFORMANCE_REVIEW.md`).
 */
export async function listAccountBundles(workspaceId: string): Promise<AccountBundle[]> {
  const db = getDb();
  const [accountRows, sourceRows, contactRows, contactPointRows, intelligenceRows] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.workspaceId, workspaceId)),
    db
      .select({ source: accountSources })
      .from(accountSources)
      .innerJoin(accounts, eq(accountSources.accountId, accounts.id))
      .where(eq(accounts.workspaceId, workspaceId)),
    db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId)),
    db.select().from(contactPoints).where(eq(contactPoints.workspaceId, workspaceId)),
    db.execute(sql`
      SELECT DISTINCT ON (account_id)
        account_id, fit_score, fit_tier, confidence, analysis_json, completed_at
      FROM prospect_analyses
      WHERE workspace_id = ${workspaceId}::uuid AND status = 'completed'
      ORDER BY account_id, completed_at DESC, created_at DESC
    `),
  ]);

  const intelligenceByAccount = new Map<string, AccountIntelligence>();
  for (const row of intelligenceRows.rows as Array<Record<string, unknown>>) {
    if (typeof row.account_id === "string") intelligenceByAccount.set(row.account_id, mapIntelligence(row));
  }

  const sourcesByAccount = new Map<string, AccountSource[]>();
  for (const { source } of sourceRows) {
    const mapped = toAccountSource(source);
    const list = sourcesByAccount.get(mapped.accountId) ?? [];
    list.push(mapped);
    sourcesByAccount.set(mapped.accountId, list);
  }

  const contactsByAccount = new Map<string, Contact[]>();
  for (const row of contactRows) {
    const mapped = toContact(row);
    const list = contactsByAccount.get(mapped.accountId) ?? [];
    list.push(mapped);
    contactsByAccount.set(mapped.accountId, list);
  }

  const contactPointsByAccount = new Map<string, ContactPoint[]>();
  for (const row of contactPointRows) {
    const mapped = toContactPoint(row);
    const list = contactPointsByAccount.get(mapped.accountId) ?? [];
    list.push(mapped);
    contactPointsByAccount.set(mapped.accountId, list);
  }

  return accountRows.map((row) => {
    const account = toAccount(row);
    return {
      account,
      sources: sourcesByAccount.get(account.id) ?? [],
      contacts: contactsByAccount.get(account.id) ?? [],
      contactPoints: contactPointsByAccount.get(account.id) ?? [],
      intelligence: intelligenceByAccount.get(account.id) ?? null,
    };
  });
}

export async function listAccountSummaryRows(
  workspaceId: string,
  limit: number,
  cursor: AccountListCursor | null,
): Promise<AccountListSummary[]> {
  const db = getDb();
  const cursorCondition = cursor
    ? sql`AND (
        a.created_at > ${cursor.createdAt}::timestamptz
        OR (a.created_at = ${cursor.createdAt}::timestamptz AND a.id > ${cursor.id}::uuid)
      )`
    : sql``;
  const result = await db.execute(sql`
    WITH account_page AS (
      SELECT
        a.id,
        a.canonical_name,
        a.business_type,
        a.province,
        a.fit_score::float8 AS fit_score,
        a.fit_tier,
        a.created_at
      FROM accounts a
      WHERE a.workspace_id = ${workspaceId}::uuid
        ${cursorCondition}
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ${limit}
    ),
    source_counts AS (
      SELECT account_id, count(*) AS source_count
      FROM account_sources
      WHERE account_id IN (SELECT id FROM account_page)
      GROUP BY account_id
    ),
    contact_counts AS (
      SELECT account_id, count(*) AS contact_count
      FROM contacts
      WHERE workspace_id = ${workspaceId}::uuid
        AND account_id IN (SELECT id FROM account_page)
      GROUP BY account_id
    ),
    latest_analyses AS (
      SELECT DISTINCT ON (pa.account_id)
        pa.account_id,
        pa.fit_score,
        pa.fit_tier,
        pa.confidence::float8 AS confidence,
        pa.completed_at,
        pa.analysis_json ->> 'reasonSummary' AS reason_summary
      FROM prospect_analyses pa
      WHERE pa.workspace_id = ${workspaceId}::uuid
        AND pa.status = 'completed'
        AND pa.account_id IN (SELECT id FROM account_page)
      ORDER BY pa.account_id, pa.completed_at DESC, pa.created_at DESC
    )
    SELECT
      page.id,
      page.canonical_name,
      page.business_type,
      page.province,
      page.fit_score,
      page.fit_tier,
      page.created_at,
      COALESCE(source_counts.source_count, 0) AS source_count,
      COALESCE(contact_counts.contact_count, 0) AS contact_count,
      latest_analyses.account_id AS analyzed_account_id,
      latest_analyses.fit_score AS analysis_fit_score,
      latest_analyses.fit_tier AS analysis_fit_tier,
      latest_analyses.confidence,
      latest_analyses.completed_at,
      latest_analyses.reason_summary
    FROM account_page page
    LEFT JOIN source_counts ON source_counts.account_id = page.id
    LEFT JOIN contact_counts ON contact_counts.account_id = page.id
    LEFT JOIN latest_analyses ON latest_analyses.account_id = page.id
    ORDER BY page.created_at ASC, page.id ASC
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    account: {
      id: String(row.id),
      canonicalName: String(row.canonical_name),
      businessType: String(row.business_type) as Account["businessType"],
      province: typeof row.province === "string" ? row.province : null,
      fitScore: safeNumeric(row.fit_score),
      fitTier: String(row.fit_tier) as Account["fitTier"],
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    contactCount: safeNumeric(row.contact_count) ?? 0,
    sourceCount: safeNumeric(row.source_count) ?? 0,
    intelligence: typeof row.analyzed_account_id === "string"
      ? {
          fitScore: safeNumeric(row.analysis_fit_score),
          fitTier: typeof row.analysis_fit_tier === "string" ? row.analysis_fit_tier : null,
          confidence: safeNumeric(row.confidence),
          lastAnalyzedAt: row.completed_at instanceof Date
            ? row.completed_at.toISOString()
            : typeof row.completed_at === "string" ? row.completed_at : null,
          reasonSummary: typeof row.reason_summary === "string" ? row.reason_summary.slice(0, 280) : null,
        }
      : null,
  }));
}

export async function getAccountBundleById(workspaceId: string, accountId: string): Promise<AccountBundle | null> {
  const db = getDb();
  const [accountRow] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
    .limit(1);
  if (!accountRow) return null;

  const [sourceRows, contactRows, contactPointRows, intelligenceRows] = await Promise.all([
    db.select({ source: accountSources })
      .from(accountSources)
      .innerJoin(accounts, eq(accountSources.accountId, accounts.id))
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId))),
    db.select().from(contacts).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.accountId, accountId))),
    db.select().from(contactPoints).where(and(eq(contactPoints.workspaceId, workspaceId), eq(contactPoints.accountId, accountId))),
    db.execute(sql`
      SELECT DISTINCT ON (account_id)
        account_id, fit_score, fit_tier, confidence, analysis_json, completed_at
      FROM prospect_analyses
      WHERE workspace_id = ${workspaceId}::uuid
        AND account_id = ${accountId}::uuid
        AND status = 'completed'
      ORDER BY account_id, completed_at DESC, created_at DESC
    `),
  ]);

  const intelligenceRow = (intelligenceRows.rows as Array<Record<string, unknown>>)[0];
  return {
    account: toAccount(accountRow),
    sources: sourceRows.map(({ source }) => toAccountSource(source)),
    contacts: contactRows.map(toContact),
    contactPoints: contactPointRows.map(toContactPoint),
    intelligence: intelligenceRow ? mapIntelligence(intelligenceRow) : null,
  };
}

export async function listSetterQueueAccounts(
  workspaceId: string,
  accountIds: string[],
  contactIds: string[],
): Promise<SetterQueueAccount[]> {
  if (accountIds.length === 0) return [];
  const db = getDb();
  const accountPromise = db
    .select({ id: accounts.id, canonicalName: accounts.canonicalName })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, accountIds)));
  const contactPromise = contactIds.length === 0
    ? Promise.resolve([])
    : db
      .select({ id: contacts.id, accountId: contacts.accountId, firstName: contacts.firstName, fullName: contacts.fullName })
      .from(contacts)
      .where(and(
        eq(contacts.workspaceId, workspaceId),
        inArray(contacts.accountId, accountIds),
        inArray(contacts.id, contactIds),
      ));
  const [accountRows, contactRows] = await Promise.all([accountPromise, contactPromise]);
  const contactsByAccount = new Map<string, SetterQueueAccount["contacts"]>();
  for (const contact of contactRows) {
    const accountContacts = contactsByAccount.get(contact.accountId) ?? [];
    accountContacts.push({ id: contact.id, firstName: contact.firstName, fullName: contact.fullName });
    contactsByAccount.set(contact.accountId, accountContacts);
  }
  return accountRows.map((account) => ({
    account,
    contacts: contactsByAccount.get(account.id) ?? [],
  }));
}

export async function listOutreachQueueDisplayData(
  workspaceId: string,
  accountIds: string[],
  contactPointIds: string[],
): Promise<{
  accounts: Array<{ id: string; canonicalName: string }>;
  contactPoints: Array<{ id: string; value: string }>;
}> {
  const db = getDb();
  const [accountRows, contactPointRows] = await Promise.all([
    accountIds.length === 0
      ? Promise.resolve([])
      : db.select({ id: accounts.id, canonicalName: accounts.canonicalName })
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, accountIds))),
    contactPointIds.length === 0
      ? Promise.resolve([])
      : db.select({ id: contactPoints.id, value: contactPoints.value })
        .from(contactPoints)
        .where(and(eq(contactPoints.workspaceId, workspaceId), inArray(contactPoints.id, contactPointIds))),
  ]);
  return { accounts: accountRows, contactPoints: contactPointRows };
}

/**
 * Bounded, indexed lookup of accounts that could plausibly match `incoming`
 * (Gate E processing cron) — feeds `evaluateAccountDedup` the same way the
 * simulation harness feeds it an in-memory `existingAccounts` array, but
 * without ever loading the whole workspace's account table. Every clause
 * mirrors one of `evaluateAccountDedup`'s own signals (strong: place id /
 * domain / phone; fuzzy: name+postal, name+address, name+geo-box) — the
 * geo clause is intentionally a slightly wider bounding box than the 150m
 * fuzzy threshold, since the exact haversine distance is still computed by
 * `evaluateAccountDedup` itself; this is only a candidate prefilter.
 */
export async function findCandidateAccountMatches(
  workspaceId: string,
  incoming: Omit<AccountIdentitySignals, "accountId">,
): Promise<AccountIdentitySignals[]> {
  const db = getDb();
  const clauses = [];

  if (incoming.googlePlaceId) clauses.push(eq(accounts.googlePlaceId, incoming.googlePlaceId));
  if (incoming.normalizedDomain) clauses.push(eq(accounts.normalizedDomain, incoming.normalizedDomain));
  if (incoming.normalizedPhone) clauses.push(eq(accounts.normalizedPhone, incoming.normalizedPhone));
  if (incoming.normalizedName && incoming.postalCode) {
    clauses.push(and(eq(accounts.normalizedName, incoming.normalizedName), eq(accounts.postalCode, incoming.postalCode)));
  }
  if (incoming.normalizedName && incoming.normalizedAddress) {
    clauses.push(and(eq(accounts.normalizedName, incoming.normalizedName), eq(accounts.normalizedAddress, incoming.normalizedAddress)));
  }
  if (incoming.normalizedName && typeof incoming.latitude === "number" && typeof incoming.longitude === "number") {
    const boxDeg = 0.002; // ~200m, deliberately wider than the 150m fuzzy threshold — a prefilter, not the final distance check
    clauses.push(
      and(
        eq(accounts.normalizedName, incoming.normalizedName),
        gte(accounts.latitude, incoming.latitude - boxDeg),
        lte(accounts.latitude, incoming.latitude + boxDeg),
        gte(accounts.longitude, incoming.longitude - boxDeg),
        lte(accounts.longitude, incoming.longitude + boxDeg),
      ),
    );
  }

  if (clauses.length === 0) return [];

  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), or(...clauses)))
    .limit(20);

  return rows.map((row) => ({
    accountId: row.id,
    normalizedName: row.normalizedName,
    googlePlaceId: row.googlePlaceId,
    normalizedDomain: row.normalizedDomain,
    normalizedPhone: row.normalizedPhone,
    postalCode: row.postalCode,
    normalizedAddress: row.normalizedAddress,
    latitude: row.latitude,
    longitude: row.longitude,
  }));
}

export interface InsertAccountInput {
  workspaceId: string;
  canonicalName: string;
  normalizedName: string;
  businessType: BusinessType;
  countryCode: string | null;
  region: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  addressLine: string | null;
  normalizedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  normalizedPhone: string | null;
  websiteUrl: string | null;
  normalizedDomain: string | null;
  googlePlaceId: string | null;
  mapsUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  status: AccountStatus;
}

export type CanonicalAccountResolution =
  | { kind: "existingAccount"; existingAccountId: string; matchedSignal: string }
  | { kind: "createNewAccount"; accountId: string }
  | { kind: "needsReview"; matchedAccountId: string | null; matchedSignal: string };

/**
 * Resolves and, when safe, creates an account in one transaction. The
 * transaction-scoped workspace lock serializes the read/insert decision even
 * with Neon HTTP, where interactive Drizzle transactions are unavailable.
 */
export async function resolveCanonicalAccount(
  workspaceId: string,
  incoming: Omit<AccountIdentitySignals, "accountId">,
  account: InsertAccountInput,
  options: { allowCreate?: boolean } = {},
): Promise<CanonicalAccountResolution> {
  if (account.workspaceId !== workspaceId) throw new Error("Canonical account workspace does not match the resolver scope.");
  const sqlClient = getNeonSql();
  const transactionResults = await sqlClient.transaction([
    sqlClient`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`,
    sqlClient`
    WITH match_candidates AS MATERIALIZED (
      SELECT
        a.id,
        CASE
          WHEN ${incoming.googlePlaceId ?? null}::text IS NOT NULL AND a.google_place_id = ${incoming.googlePlaceId ?? null} THEN 'google_place_id'
          WHEN ${incoming.normalizedDomain ?? null}::text IS NOT NULL AND a.normalized_domain = ${incoming.normalizedDomain ?? null} THEN 'normalized_domain'
          WHEN ${incoming.normalizedPhone ?? null}::text IS NOT NULL AND a.normalized_phone = ${incoming.normalizedPhone ?? null} THEN 'normalized_phone'
          WHEN ${incoming.normalizedName}::text IS NOT NULL AND ${incoming.normalizedAddress ?? null}::text IS NOT NULL
            AND a.normalized_name = ${incoming.normalizedName} AND a.normalized_address = ${incoming.normalizedAddress ?? null} THEN 'name_address'
          WHEN ${incoming.normalizedName}::text IS NOT NULL AND ${incoming.postalCode ?? null}::text IS NOT NULL
            AND a.normalized_name = ${incoming.normalizedName} AND a.postal_code = ${incoming.postalCode ?? null} THEN 'name_postal_code'
          ELSE 'name_geo_proximity'
        END AS matched_signal
      FROM accounts a
      WHERE a.workspace_id = ${workspaceId}::uuid
        AND (
          (${incoming.googlePlaceId ?? null}::text IS NOT NULL AND a.google_place_id = ${incoming.googlePlaceId ?? null})
          OR (${incoming.normalizedDomain ?? null}::text IS NOT NULL AND a.normalized_domain = ${incoming.normalizedDomain ?? null})
          OR (${incoming.normalizedPhone ?? null}::text IS NOT NULL AND a.normalized_phone = ${incoming.normalizedPhone ?? null})
          OR (${incoming.normalizedName}::text IS NOT NULL AND ${incoming.normalizedAddress ?? null}::text IS NOT NULL
            AND a.normalized_name = ${incoming.normalizedName} AND a.normalized_address = ${incoming.normalizedAddress ?? null})
          OR (${incoming.normalizedName}::text IS NOT NULL AND ${incoming.postalCode ?? null}::text IS NOT NULL
            AND a.normalized_name = ${incoming.normalizedName} AND a.postal_code = ${incoming.postalCode ?? null})
          OR (
            ${incoming.normalizedName}::text IS NOT NULL
            AND ${incoming.latitude ?? null}::double precision IS NOT NULL
            AND ${incoming.longitude ?? null}::double precision IS NOT NULL
            AND a.normalized_name = ${incoming.normalizedName}
            AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
            AND 6371000 * 2 * asin(sqrt(least(1,
              sin(radians(a.latitude - ${incoming.latitude ?? null}::double precision) / 2)^2
              + cos(radians(${incoming.latitude ?? null}::double precision)) * cos(radians(a.latitude))
              * sin(radians(a.longitude - ${incoming.longitude ?? null}::double precision) / 2)^2
            ))) <= 150
          )
        )
    ),
    matched AS MATERIALIZED (
      SELECT
        id,
        matched_signal,
        count(*) OVER (PARTITION BY matched_signal) AS signal_match_count
      FROM match_candidates
      ORDER BY CASE
        WHEN matched_signal = 'google_place_id' THEN 1
        WHEN matched_signal = 'normalized_domain' THEN 2
        WHEN matched_signal = 'normalized_phone' THEN 3
        WHEN matched_signal = 'name_address' THEN 4
        WHEN matched_signal = 'name_postal_code' THEN 5
        ELSE 6
      END
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO accounts (
        workspace_id, canonical_name, normalized_name, business_type, country_code,
        region, province, city, postal_code, address_line, normalized_address,
        latitude, longitude, phone, normalized_phone, website_url, normalized_domain,
        google_place_id, maps_url, rating, review_count, status
      )
      SELECT
        ${account.workspaceId}::uuid, ${account.canonicalName}, ${account.normalizedName}, ${account.businessType}, ${account.countryCode},
        ${account.region}, ${account.province}, ${account.city}, ${account.postalCode}, ${account.addressLine}, ${account.normalizedAddress},
        ${account.latitude}, ${account.longitude}, ${account.phone}, ${account.normalizedPhone}, ${account.websiteUrl}, ${account.normalizedDomain},
        ${account.googlePlaceId}, ${account.mapsUrl}, ${account.rating}, ${account.reviewCount}, ${account.status}
      WHERE NOT EXISTS (SELECT 1 FROM matched)
        AND ${options.allowCreate !== false}
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT
      CASE WHEN matched_signal = 'name_geo_proximity' OR signal_match_count > 1 THEN 'needsReview' ELSE 'existingAccount' END AS resolution,
      id AS account_id,
      matched_signal
    FROM matched
    UNION ALL
    SELECT 'createNewAccount' AS resolution, id AS account_id, NULL AS matched_signal FROM inserted
    UNION ALL
    SELECT 'needsReview' AS resolution, NULL::uuid AS account_id, 'unmatched_linkedin_profile' AS matched_signal
    WHERE ${options.allowCreate !== false} = false
      AND NOT EXISTS (SELECT 1 FROM matched)
      AND NOT EXISTS (SELECT 1 FROM inserted)
  `,
  ], { isolationLevel: "ReadCommitted" });
  const row = transactionResults[1]?.[0] as { resolution: string; account_id: string; matched_signal: string | null } | undefined;
  if (!row) {
    const concurrentCandidates = await findCandidateAccountMatches(workspaceId, incoming);
    const concurrentDecision = evaluateAccountDedup(incoming, concurrentCandidates);
    if (concurrentDecision.action === "merge" && concurrentDecision.matches[0]) {
      return {
        kind: "existingAccount",
        existingAccountId: concurrentDecision.matches[0].accountId,
        matchedSignal: concurrentDecision.matches[0].signal,
      };
    }
    if (concurrentDecision.action === "flag_for_review" && concurrentDecision.matches[0]) {
      return {
        kind: "needsReview",
        matchedAccountId: concurrentDecision.matches[0].accountId,
        matchedSignal: concurrentDecision.matches[0].signal,
      };
    }
    throw new Error("Canonical account insert conflicted but no matching account could be resolved; retry processing.");
  }
  if (row.resolution === "createNewAccount") return { kind: "createNewAccount", accountId: row.account_id };
  if (row.resolution === "needsReview") {
    return { kind: "needsReview", matchedAccountId: row.account_id, matchedSignal: row.matched_signal ?? "name_geo_proximity" };
  }
  return { kind: "existingAccount", existingAccountId: row.account_id, matchedSignal: row.matched_signal ?? "unknown" };
}

export async function getAccountById(accountId: string): Promise<Account | null> {
  const db = getDb();
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return row ? toAccount(row) : null;
}

export async function getContactById(contactId: string): Promise<Contact | null> {
  const db = getDb();
  const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return row ? toContact(row) : null;
}

export async function updateAccountFields(accountId: string, fields: Partial<InsertAccountInput>): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const db = getDb();
  await db.update(accounts).set({ ...fields, updatedAt: new Date() }).where(eq(accounts.id, accountId));
}

export interface InsertAccountSourceInput {
  accountId: string;
  sourceType: AccountSource["sourceType"];
  sourceProvider: string;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  rawSnapshot: Record<string, unknown>;
}

export async function insertAccountSource(input: InsertAccountSourceInput): Promise<void> {
  const db = getDb();
  await db.insert(accountSources).values(input).onConflictDoNothing();
}

export async function updateAccountStatus(accountId: string, status: AccountStatus): Promise<void> {
  const db = getDb();
  await db.update(accounts).set({ status, updatedAt: new Date() }).where(eq(accounts.id, accountId));
}

export interface InsertContactPointInput {
  workspaceId: string;
  accountId: string;
  type: ContactPointType;
  value: string;
  normalizedValue: string;
  label: string | null;
  isGeneric: boolean;
  isPersonalOrNamed: boolean;
  priorityScore: number;
  verificationStatus: VerificationStatus;
  verificationProvider: string | null;
  verificationCheckedAt?: Date | null;
  sourceUrl: string | null;
  sourceType: string | null;
}

/** `ContactPointStatus` and `VerificationStatus` overlap but are not identical enums — `unknown`/`disposable`/`bounced` have no direct status equivalent, so they fall back to `"discovered"` (endpoint exists, verification outcome inconclusive). */
function verificationToContactPointStatus(verificationStatus: VerificationStatus): ContactPoint["status"] {
  switch (verificationStatus) {
    case "valid":
    case "catch_all":
    case "risky":
    case "invalid":
      return verificationStatus;
    case "unverified":
    case "unknown":
    case "disposable":
    case "bounced":
    default:
      return "discovered";
  }
}

/**
 * Inserts one discovered contact point. `contactId` is deliberately left
 * null — the candidate processor (`processRawCandidate`) only ever produces
 * role-labeled email evidence, never a named person, so there is no
 * `Contact` identity to attach yet (see `ContactPoint.contactId`'s own
 * nullability for exactly this case). `channelEligibility` stays `"unknown"`
 * — no compliance-classification rule for newly-discovered public business
 * emails is specified anywhere in the spec yet (a real, pre-existing gap,
 * not something Gate E invents an answer for); `status` mirrors the
 * verification outcome directly, which is the one fact actually known.
 */
export async function insertContactPoint(input: InsertContactPointInput): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(contactPoints)
    .values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      contactId: null,
      type: input.type,
      value: input.value,
      normalizedValue: input.normalizedValue,
      label: input.label,
      isGeneric: input.isGeneric,
      isPersonalOrNamed: input.isPersonalOrNamed,
      priorityScore: input.priorityScore,
      verificationStatus: input.verificationStatus,
      verificationProvider: input.verificationProvider,
      verificationCheckedAt: input.verificationCheckedAt ?? (input.verificationStatus === "unverified" ? null : new Date()),
      channelEligibility: deriveEmailChannelEligibility(),
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      status: verificationToContactPointStatus(input.verificationStatus),
    })
    .onConflictDoNothing({ target: [contactPoints.workspaceId, contactPoints.accountId, contactPoints.type, contactPoints.normalizedValue] })
    .returning({ id: contactPoints.id });
  if (row) return row.id;

  const [existing] = await db.select({ id: contactPoints.id })
    .from(contactPoints)
    .where(and(
      eq(contactPoints.workspaceId, input.workspaceId),
      eq(contactPoints.accountId, input.accountId),
      eq(contactPoints.type, input.type),
      eq(contactPoints.normalizedValue, input.normalizedValue),
    ))
    .limit(1);
  return existing?.id ?? "";
}
