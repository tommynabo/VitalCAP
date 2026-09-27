import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, desc } from "drizzle-orm";
import { ProspectContext, EvidenceFact } from "./types";

export class ProspectContextBuilder {
  async buildContext(campaignId: string, accountId: string): Promise<ProspectContext | null> {
    const db = getDb();
    
    const campaignRows = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId))
      .limit(1);
    const campaignData = campaignRows[0];
    if (!campaignData) return null;

    const offerRows = await db
      .select()
      .from(schema.offers)
      .where(eq(schema.offers.id, campaignData.offerId))
      .limit(1);
    const offerData = offerRows[0];
    if (!offerData) return null;

    const accountRows = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1);
    const accountData = accountRows[0];
    if (!accountData) return null;

    const evidence: EvidenceFact[] = [];

    // Maps/Account core facts as evidence
    evidence.push({
      id: `account:${accountData.id}:business_type`,
      type: "core_fact",
      value: `Business type: ${accountData.businessType}`,
      sourceUrl: null,
      snippet: null,
    });
    evidence.push({
      id: `account:${accountData.id}:location`,
      type: "core_fact",
      value: `Location: ${accountData.city}, ${accountData.region}, ${accountData.countryCode}`,
      sourceUrl: null,
      snippet: null,
    });
    if (accountData.rating) {
      evidence.push({
        id: `account:${accountData.id}:rating`,
        type: "core_fact",
        value: `Rating: ${accountData.rating} (${accountData.reviewCount} reviews)`,
        sourceUrl: null,
        snippet: null,
      });
    }

    const accountSources = await db
      .select()
      .from(schema.accountSources)
      .where(eq(schema.accountSources.accountId, accountId));

    // Sort deterministically by sourceId
    accountSources.sort((a, b) => a.id.localeCompare(b.id));

    for (const source of accountSources) {
      if (source.sourceProvider === 'apify' || source.sourceProvider === 'google_maps' || source.sourceProvider === 'google') {
        const snap = source.rawSnapshot as any;
        const url = snap?.url || source.sourceUrl || null;
        if (snap?.categories && Array.isArray(snap.categories)) {
          evidence.push({
            id: `source:${source.id}:categories`,
            type: "maps_signal",
            value: `Categories: ${snap.categories.join(", ")}`,
            sourceUrl: url,
            snippet: null,
          });
        }
        if (snap?.description) {
          evidence.push({
            id: `source:${source.id}:description`,
            type: "maps_signal",
            value: snap.description,
            sourceUrl: url,
            snippet: null,
          });
        }
        if (snap?.reviews && Array.isArray(snap.reviews)) {
          snap.reviews.slice(0, 5).forEach((r: any, idx: number) => {
            evidence.push({
              id: `source:${source.id}:review:${idx}`,
              type: "maps_review",
              value: r.text || "",
              sourceUrl: url,
              snippet: `Rating: ${r.rating}`,
            });
          });
        }
      }
    }

    // Website Evidence - bounded
    const websiteRows = await db
      .select()
      .from(schema.websiteEvidence)
      .where(eq(schema.websiteEvidence.accountId, accountId))
      .orderBy(desc(schema.websiteEvidence.fetchedAt))
      .limit(20); // Bounded to 20

    // Deterministic sort for hashing
    websiteRows.sort((a, b) => a.id.localeCompare(b.id));

    for (const we of websiteRows) {
      evidence.push({
        id: `website:${we.id}`,
        type: we.evidenceType,
        value: we.normalizedValue,
        sourceUrl: we.sourceUrl,
        snippet: we.snippet,
      });
    }

    // Sort all evidence deterministically by id
    evidence.sort((a, b) => a.id.localeCompare(b.id));

    // Contact points
    const contactPoints = await db
      .select()
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.accountId, accountId));
    
    // Deterministic sort
    contactPoints.sort((a, b) => a.id.localeCompare(b.id));

    return {
      workspaceId: campaignData.workspaceId,
      campaignId: campaignId,
      accountId: accountId,
      account: {
        id: accountData.id,
        normalizedName: accountData.normalizedName,
        normalizedDomain: accountData.normalizedDomain,
        businessType: accountData.businessType,
        location: {
          city: accountData.city,
          region: accountData.region,
          country: accountData.countryCode,
        },
        metrics: {
          rating: accountData.rating ? Number(accountData.rating) : null,
          reviewCount: accountData.reviewCount,
        }
      },
      offer: {
        name: offerData.name,
        company: offerData.company,
        description: offerData.description,
        primaryCta: offerData.primaryCta,
        approvedClaims: Array.isArray(offerData.approvedClaims) ? offerData.approvedClaims as string[] : [],
        forbiddenClaims: Array.isArray(offerData.forbiddenClaims) ? offerData.forbiddenClaims as string[] : [],
      },
      campaign: {
        name: campaignData.name,
        description: campaignData.description,
      },
      evidence,
      contactPoints: contactPoints.map(cp => ({
        id: cp.id,
        channel: cp.type,
        title: cp.label,
        name: cp.isPersonalOrNamed ? "Named" : "Generic",
      })),
    };
  }
}
