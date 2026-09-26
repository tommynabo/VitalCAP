import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, accountSources } from "../schema/accounts";
import { contacts, contactPoints } from "../schema/contacts";
import type { Account, AccountSource, AccountStatus, BusinessType } from "@/domain/accounts/types";
import type { Contact, ContactPoint, ContactPointType, VerificationStatus } from "@/domain/contacts/types";
import type { AccountIdentitySignals } from "@/services/deduplication/account-dedup";

export interface AccountBundle {
  account: Account;
  sources: AccountSource[];
  contacts: Contact[];
  contactPoints: ContactPoint[];
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
  const [accountRows, sourceRows, contactRows, contactPointRows] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.workspaceId, workspaceId)),
    db
      .select({ source: accountSources })
      .from(accountSources)
      .innerJoin(accounts, eq(accountSources.accountId, accounts.id))
      .where(eq(accounts.workspaceId, workspaceId)),
    db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId)),
    db.select().from(contactPoints).where(eq(contactPoints.workspaceId, workspaceId)),
  ]);

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
    };
  });
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

/** Inserts a brand-new account row. Callers must have already confirmed via `findCandidateAccountMatches` + `evaluateAccountDedup` that no existing account matches. */
export async function insertAccount(input: InsertAccountInput): Promise<string> {
  const db = getDb();
  const [row] = await db.insert(accounts).values(input).returning({ id: accounts.id });
  if (!row) throw new Error("Failed to insert account.");
  return row.id;
}

export async function getAccountById(accountId: string): Promise<Account | null> {
  const db = getDb();
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return row ? toAccount(row) : null;
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
  const sourceIdentity = input.sourceExternalId
    ? and(eq(accountSources.sourceProvider, input.sourceProvider), eq(accountSources.sourceExternalId, input.sourceExternalId))
    : and(
        eq(accountSources.sourceProvider, input.sourceProvider),
        input.sourceUrl ? eq(accountSources.sourceUrl, input.sourceUrl) : isNull(accountSources.sourceUrl),
      );
  const [existing] = await db
    .select({ id: accountSources.id })
    .from(accountSources)
    .where(and(eq(accountSources.accountId, input.accountId), sourceIdentity))
    .limit(1);
  if (existing) return;
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
      verificationCheckedAt: new Date(),
      channelEligibility: "unknown",
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      status: verificationToContactPointStatus(input.verificationStatus),
    })
    .onConflictDoNothing({ target: [contactPoints.workspaceId, contactPoints.type, contactPoints.normalizedValue] })
    .returning({ id: contactPoints.id });
  return row?.id ?? "";
}
