import { eq } from "drizzle-orm";
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
