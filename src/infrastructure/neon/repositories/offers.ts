import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { offers } from "../schema/campaigns";
import type { Offer } from "@/domain/campaigns/types";

function toOffer(row: typeof offers.$inferSelect): Offer {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    company: row.company,
    description: row.description,
    primaryCta: row.primaryCta,
    bookingUrl: row.bookingUrl,
    approvedCommercialFacts: row.approvedCommercialFacts as Offer["approvedCommercialFacts"],
    approvedProductFacts: row.approvedProductFacts as Offer["approvedProductFacts"],
    approvedClaims: row.approvedClaims as string[],
    forbiddenClaims: row.forbiddenClaims as string[],
    faq: row.faq as Offer["faq"],
    objectionGuidance: row.objectionGuidance as Offer["objectionGuidance"],
    toneConfig: row.toneConfig as Offer["toneConfig"],
    active: row.active,
  };
}

/** Returns the first (and, in this product's current single-offer-per-workspace model, only) offer. */
export async function getPrimaryOffer(workspaceId: string): Promise<Offer | null> {
  const db = getDb();
  const [row] = await db.select().from(offers).where(eq(offers.workspaceId, workspaceId)).limit(1);
  return row ? toOffer(row) : null;
}

/**
 * A new workspace should be able to configure discovery before commercial
 * details are entered. This placeholder carries no claims and remains
 * inactive, but satisfies the campaign foreign key until the offer is
 * configured in Settings.
 */
export async function getOrCreatePrimaryOffer(workspaceId: string): Promise<Offer> {
  const existing = await getPrimaryOffer(workspaceId);
  if (existing) return existing;

  const db = getDb();
  const [created] = await db
    .insert(offers)
    .values({
      workspaceId,
      name: "Default workspace offer",
      company: "Not configured",
      description: "Commercial offer details have not been configured yet.",
      primaryCta: "Contact",
      bookingUrl: "",
      approvedCommercialFacts: {},
      approvedProductFacts: {},
      approvedClaims: [],
      forbiddenClaims: [],
      faq: [],
      objectionGuidance: {},
      toneConfig: {},
      active: false,
    })
    .returning();
  if (!created) throw new Error("Failed to initialize workspace offer.");
  return toOffer(created);
}

/** Looks up an offer only inside the calling workspace. */
export async function getOfferById(workspaceId: string, offerId: string): Promise<Offer | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.workspaceId, workspaceId), eq(offers.id, offerId)))
    .limit(1);
  return row ? toOffer(row) : null;
}
