import { getDb, schema } from "@/infrastructure/neon/db";
import { and, eq, sql } from "drizzle-orm";
import { createVerificationAcceptancePolicy, isContactPointAcceptable } from "@/services/verification/acceptance-policy";
import { evaluateContactEligibility } from "@/services/verification/contact-eligibility";
import { getVerificationEnv } from "@/lib/config/env";
import { selectPreferredContactPoint } from "./contact-selection-policy";
import { isEmailChannelEligible } from "./email-channel-policy";
import type { ChannelEligibilityStatus } from "@/domain/contacts/types";

function getRoleScore(contact: any, label: string | null): number {
  const role = contact?.roleType?.toLowerCase() || label?.toLowerCase() || "";
  const title = contact?.jobTitle?.toLowerCase() || "";
  const seniority = contact?.seniority?.toLowerCase() || "";

  if (role.includes("owner") || title.includes("titular") || seniority.includes("owner")) return 1;
  if (role.includes("purchasing") || role.includes("compras") || role.includes("pedidos") || title.includes("buyer") || role.includes("buyer")) return 2;
  if (role.includes("manager") || role.includes("gerencia") || title.includes("manager") || title.includes("gerente") || title.includes("director")) return 3;
  if (role.includes("professional") || title.includes("pharmacist") || title.includes("farmaceutico")) return 4;
  return contact ? 10 : 99;
}

export async function selectPrimaryContact(workspaceId: string, campaignId: string, accountId: string): Promise<string | null> {
  const db = getDb();
  
  // Get all email contact points and their related contacts
  const rows = await db.select({
    cp: schema.contactPoints,
    contact: schema.contacts,
    decision: schema.complianceDecisions
  })
  .from(schema.contactPoints)
  .leftJoin(schema.contacts, eq(schema.contactPoints.contactId, schema.contacts.id))
  .leftJoin(schema.complianceDecisions, and(
    eq(schema.complianceDecisions.contactPointId, schema.contactPoints.id),
    eq(schema.complianceDecisions.campaignId, campaignId),
    sql`superseded_at IS NULL`
  ))
  .where(and(
    eq(schema.contactPoints.accountId, accountId),
    eq(schema.contactPoints.type, "email")
  ));

  if (rows.length === 0) return null;
  const acceptancePolicy = createVerificationAcceptancePolicy(getVerificationEnv().EMAIL_VERIFICATION_ALLOW_CATCH_ALL);

  const eligible = rows.filter(({ cp, decision }) =>
    decision?.eligibilityAfter === "allowed"
    && isEmailChannelEligible(cp.channelEligibility as ChannelEligibilityStatus)
    && isContactPointAcceptable(cp.verificationStatus as any, acceptancePolicy)
    && evaluateContactEligibility({ hasEmail: cp.type === "email", verificationStatus: cp.verificationStatus as any, allowCatchAll: acceptancePolicy.acceptedStatuses.includes("catch_all") }).eligible,
  );

  const preferred = selectPreferredContactPoint(eligible.map(({ cp, contact }) => ({
    id: cp.id,
    isPersonalOrNamed: cp.isPersonalOrNamed,
    isDecisionMaker: contact?.isDecisionMaker ?? false,
    isGeneric: cp.isGeneric,
    priorityScore: Number(cp.priorityScore),
    roleScore: getRoleScore(contact, cp.label),
    verificationStatus: cp.verificationStatus as "valid" | "catch_all",
  })));
  return preferred?.id ?? null;
}
