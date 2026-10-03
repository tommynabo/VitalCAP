import { getDb, schema } from "@/infrastructure/neon/db";
import { eq, desc } from "drizzle-orm";
import { ProspectContext, EvidenceFact } from "./types";

const PRIMARY_ICP_BUSINESS_TYPES = ["pharmacy", "parapharmacy", "herbal_shop"];

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown, maxLength = 500): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function safeStringList(value: unknown, maxItems = 10): string[] {
  return Array.isArray(value)
    ? value.slice(0, maxItems).flatMap((item) => {
        const text = safeText(item, 240);
        return text ? [text] : [];
      })
    : [];
}

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
      value: `Business type: ${accountData.businessType.slice(0, 80)}`,
      sourceUrl: null,
      snippet: null,
    });
    evidence.push({
      id: `account:${accountData.id}:location`,
      type: "core_fact",
      value: `Location: ${safeText(accountData.city, 100) ?? "unknown"}, ${safeText(accountData.region, 100) ?? "unknown"}, ${safeText(accountData.countryCode, 10) ?? "unknown"}`,
      sourceUrl: null,
      snippet: null,
    });
    if (accountData.rating !== null) {
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
      .where(eq(schema.accountSources.accountId, accountId))
      .orderBy(schema.accountSources.id)
      .limit(40);

    // Sort deterministically by sourceId
    accountSources.sort((a, b) => a.id.localeCompare(b.id));

    for (const source of accountSources) {
      const snapshot = recordOf(source.rawSnapshot);
      const mapsPlace = recordOf(snapshot.place);
      const serpResult = recordOf(snapshot.result ?? snapshot.profile);
      const url = safeText(snapshot.url, 500) ?? safeText(serpResult.url, 500) ?? safeText(source.sourceUrl, 500);
      if (["apify", "google_maps", "google"].includes(source.sourceProvider)) {
        const categories = [
          ...safeStringList(snapshot.categories, 12),
          ...[safeText(mapsPlace.category, 240)].filter((category): category is string => Boolean(category)),
        ].slice(0, 12);
        const description = safeText(snapshot.description ?? mapsPlace.description);
        if (categories.length > 0) {
          evidence.push({
            id: `source:${source.id}:categories`,
            type: "maps_signal",
            value: `Categories: ${categories.join(", ")}`,
            sourceUrl: url,
            snippet: null,
          });
        }
        if (description) {
          evidence.push({
            id: `source:${source.id}:description`,
            type: "maps_signal",
            value: description,
            sourceUrl: url,
            snippet: null,
          });
        }
        const mapMetadata = [
          safeText(mapsPlace.address, 240),
          typeof mapsPlace.rating === "number" ? `Rating: ${mapsPlace.rating}` : null,
          typeof mapsPlace.reviewCount === "number" ? `Reviews: ${mapsPlace.reviewCount}` : null,
        ].filter(Boolean);
        if (mapMetadata.length > 0) {
          evidence.push({
            id: `source:${source.id}:metadata`,
            type: "maps_signal",
            value: mapMetadata.join("; "),
            sourceUrl: url,
            snippet: null,
          });
        }
        const reviews = Array.isArray(snapshot.reviews) ? snapshot.reviews : mapsPlace.reviews;
        if (Array.isArray(reviews)) {
          reviews.slice(0, 5).forEach((review, idx) => {
            const reviewRecord = recordOf(review);
            const text = safeText(reviewRecord.text);
            if (!text) return;
            evidence.push({
              id: `source:${source.id}:review:${idx}`,
              type: "maps_review",
              value: text,
              sourceUrl: url,
              snippet: typeof reviewRecord.rating === "number" ? `Rating: ${reviewRecord.rating}` : null,
            });
          });
        }
      }

      if (source.sourceType === "google_serp" || source.sourceProvider === "serper") {
        const results = snapshot.result
          ? [snapshot.result]
          : snapshot.profile
          ? [snapshot.profile]
          : Array.isArray(snapshot.organicResults)
          ? snapshot.organicResults
          : Array.isArray(snapshot.results) ? snapshot.results : [];
        results.slice(0, 5).forEach((result, idx) => {
          const resultRecord = recordOf(result);
          const title = safeText(resultRecord.title, 240);
          const snippet = safeText(resultRecord.snippet ?? resultRecord.description);
          if (!title && !snippet) return;
          evidence.push({
            id: `source:${source.id}:serp:${idx}`,
            type: "serp_evidence",
            value: [title, snippet].filter(Boolean).join(" — "),
            sourceUrl: safeText(resultRecord.link ?? resultRecord.url, 500) ?? url,
            snippet,
          });
        });
      }

      if (source.sourceType === "linkedin_owner" || snapshot.kind === "maps_deep_owner_enrichment") {
        const ownerResult = serpResult;
        const ownerName = safeText(snapshot.name ?? snapshot.fullName ?? ownerResult.name, 160);
        const ownerTitle = safeText(snapshot.title ?? snapshot.role ?? ownerResult.title, 240);
        const ownerEvidence = [ownerName, ownerTitle, safeText(ownerResult.snippet, 280)].filter(Boolean);
        if (ownerEvidence.length > 0) {
          evidence.push({
            id: `source:${source.id}:owner`,
            type: "owner_contact",
            value: ownerEvidence.join(" — "),
            sourceUrl: safeText(snapshot.profileUrl, 500) ?? safeText(ownerResult.url, 500) ?? url,
            snippet: safeText(ownerResult.snippet, 280),
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
      .limit(20);

    // Deterministic sort for hashing
    websiteRows.sort((a, b) => a.id.localeCompare(b.id));

    for (const we of websiteRows) {
      evidence.push({
        id: `website:${we.id}`,
        type: we.evidenceType,
        value: we.normalizedValue.slice(0, 500),
        sourceUrl: we.sourceUrl.slice(0, 500),
        snippet: we.snippet?.slice(0, 500) ?? null,
      });
    }

    const evidencePriority: Record<string, number> = {
      core_fact: 0,
      maps_signal: 1,
      owner_contact: 2,
      serp_evidence: 3,
      website_signal: 4,
      maps_review: 5,
    };
    evidence.sort((a, b) =>
      (evidencePriority[a.type] ?? 6) - (evidencePriority[b.type] ?? 6)
      || a.id.localeCompare(b.id),
    );
    evidence.splice(50);

    // Contact points
    const contactRows = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.accountId, accountId))
      .orderBy(desc(schema.contacts.updatedAt))
      .limit(20);

    const contactPoints = await db
      .select()
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.accountId, accountId))
      .orderBy(desc(schema.contactPoints.updatedAt))
      .limit(20);
    
    // Deterministic sort
    contactPoints.sort((a, b) => a.id.localeCompare(b.id));

    const engineConfig = recordOf(campaignData.engineConfig);
    const icpConfig = recordOf(engineConfig.icpCriteria);

    return {
      workspaceId: campaignData.workspaceId,
      campaignId: campaignId,
      accountId: accountId,
      account: {
        id: accountData.id,
        normalizedName: accountData.normalizedName.slice(0, 160),
        normalizedDomain: accountData.normalizedDomain?.slice(0, 160) ?? null,
        businessType: accountData.businessType.slice(0, 80),
        location: {
          city: accountData.city?.slice(0, 100) ?? null,
          region: accountData.region?.slice(0, 100) ?? null,
          country: accountData.countryCode?.slice(0, 10) ?? null,
        },
        metrics: {
          rating: accountData.rating ? Number(accountData.rating) : null,
          reviewCount: accountData.reviewCount,
        }
      },
      offer: {
        name: offerData.name.slice(0, 160),
        company: offerData.company.slice(0, 160),
        description: offerData.description.slice(0, 2_000),
        primaryCta: offerData.primaryCta.slice(0, 240),
        approvedClaims: safeStringList(offerData.approvedClaims),
        forbiddenClaims: safeStringList(offerData.forbiddenClaims),
        icpCriteria: {
          targetBusinessTypes: safeStringList(icpConfig.targetBusinessTypes, 10).length > 0
            ? safeStringList(icpConfig.targetBusinessTypes, 10)
            : PRIMARY_ICP_BUSINESS_TYPES,
          inclusionCriteria: safeStringList(icpConfig.inclusionCriteria),
          exclusionCriteria: safeStringList(icpConfig.exclusionCriteria),
        },
      },
      campaign: {
        name: campaignData.name.slice(0, 160),
        description: campaignData.description?.slice(0, 1_200) ?? null,
        minimumFitScore: campaignData.minimumFitScore,
      },
      evidence,
      contacts: contactRows.map((contact) => ({
        name: safeText(contact.fullName, 160),
        title: safeText(contact.jobTitle, 240),
        roleType: contact.roleType,
        isDecisionMaker: contact.isDecisionMaker,
      })),
      contactPoints: contactPoints.map(cp => ({
        id: cp.id,
        channel: cp.type,
        title: cp.label?.slice(0, 160) ?? null,
        name: cp.isPersonalOrNamed ? "Named" : "Generic",
      })),
    };
  }
}
