import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, desc } from "drizzle-orm";
import { ProspectContext } from "./types";

export class ProspectContextBuilder {
  async buildContext(campaignId: string, accountId: string): Promise<ProspectContext | null> {
    const db = getDb();
    
    // Fetch campaign
    const campaignRows = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId))
      .limit(1);

    const campaignData = campaignRows[0];
    if (!campaignData) return null;

    // Fetch offer
    const offerRows = await db
      .select()
      .from(schema.offers)
      .where(eq(schema.offers.id, campaignData.offerId))
      .limit(1);

    const offerData = offerRows[0];
    if (!offerData) return null;

    // Fetch account
    const accountRows = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1);

    const accountData = accountRows[0];
    if (!accountData) return null;

    // Fetch website evidence
    const websiteRows = await db
      .select()
      .from(schema.websiteEvidence)
      .where(eq(schema.websiteEvidence.accountId, accountId))
      .orderBy(desc(schema.websiteEvidence.fetchedAt))
      .limit(1);

    const websiteEvidence = websiteRows[0];

    // Fetch account sources for Maps
    const accountSources = await db
      .select()
      .from(schema.accountSources)
      .where(eq(schema.accountSources.accountId, accountId));
    
    let categories: string[] = [];
    let summary: string | null = null;
    let reviews: {text: string, rating: number}[] = [];

    // Parse Maps evidence from rawSnapshot if provider is apify or google
    for (const source of accountSources) {
      if (source.sourceProvider === 'apify' || source.sourceProvider === 'google_maps' || source.sourceProvider === 'google') {
        const snap = source.rawSnapshot as any;
        if (snap?.categories && Array.isArray(snap.categories)) {
          categories = snap.categories;
        } else if (snap?.categoryName) {
          categories = [snap.categoryName];
        }
        
        if (snap?.description) summary = snap.description;
        else if (snap?.editorialSummary) summary = snap.editorialSummary;
        else if (snap?.reviews) {
          // If no description, maybe use a snippet from top review?
        }
        
        if (snap?.reviews && Array.isArray(snap.reviews)) {
          reviews = snap.reviews.slice(0, 5).map((r: any) => ({
            text: r.text || "",
            rating: Number(r.rating) || 0
          }));
        }
      }
    }

    return {
      workspaceId: campaignData.workspaceId,
      campaignId: campaignId,
      accountId: accountId,
      account: {
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
      evidence: {
        website: {
          textContent: websiteEvidence?.value ?? null,
          scrapedAt: websiteEvidence?.fetchedAt?.toISOString() ?? null,
        },
        maps: {
          categories,
          summary,
          reviews,
        }
      }
    };
  }
}
