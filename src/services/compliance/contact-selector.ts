import { getDb, schema } from "@/infrastructure/neon/db";
import { and, eq, sql } from "drizzle-orm";
import { isContactPointAcceptable, DEFAULT_VERIFICATION_ACCEPTANCE_POLICY } from "@/services/verification/acceptance-policy";

function getRoleScore(contact: any): number {
  if (!contact) return 99; // no role
  
  const role = contact.roleType?.toLowerCase() || "";
  const title = contact.jobTitle?.toLowerCase() || "";
  const seniority = contact.seniority?.toLowerCase() || "";

  if (role.includes("owner") || title.includes("titular") || seniority.includes("owner")) return 1;
  if (role.includes("purchasing") || title.includes("buyer") || role.includes("buyer") || title.includes("compras")) return 2;
  if (role.includes("manager") || title.includes("manager") || title.includes("gerente") || title.includes("director")) return 3;
  if (role.includes("professional") || title.includes("pharmacist") || title.includes("farmaceutico")) return 4;
  return 10; // generic named professional
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

  // Score them
  const scored = rows.map(({ cp, contact, decision }) => {
    // 1. If blocked, score is worst
    if (decision?.eligibilityAfter === "blocked") return { cp, score: 999 };
    
    // 2. Verified Acceptable beats Unverified/Risky
    const isVerified = cp.verificationStatus === "valid" || cp.verificationStatus === "catch_all";
    const isAcceptable = isContactPointAcceptable(cp.verificationStatus as any, DEFAULT_VERIFICATION_ACCEPTANCE_POLICY);
    const verificationScore = (isVerified && isAcceptable) ? 0 : 100;

    // 3. Role Score
    const isGenericInfo = cp.isGeneric && (cp.normalizedValue.startsWith("info@") || cp.normalizedValue.startsWith("contacto@"));
    const isGenericBusiness = cp.isGeneric && !isGenericInfo;
    
    let roleScore = 99;
    if (contact) {
      roleScore = getRoleScore(contact);
    } else if (isGenericBusiness) {
      roleScore = 5;
    } else if (isGenericInfo) {
      roleScore = 6;
    }

    return {
      cp,
      score: verificationScore + roleScore
    };
  });

  // Sort by score ascending
  scored.sort((a, b) => a.score - b.score);

  // Return best if it's not strictly blocked (score >= 999)
  if (scored[0] && scored[0].score < 999) {
    return scored[0].cp.id;
  }

  return null;
}
