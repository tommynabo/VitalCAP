import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, accountSources } from "../schema/accounts";
import { contacts, contactPoints } from "../schema/contacts";
import type { Account, AccountSource } from "@/domain/accounts/types";
import type { Contact, ContactPoint } from "@/domain/contacts/types";

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

function toContactPoint(row: typeof contactPoints.$inferSelect): ContactPoint {
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
