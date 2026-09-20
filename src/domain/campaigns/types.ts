/**
 * Domain types for `offers` (configurable commercial knowledge) and
 * `campaigns` / `campaign_memberships` (Prompt 1 §1.1). No commercial fact
 * (price, margin, booking URL, claims) may be hard-coded in application
 * code — it must live in an `Offer` record instead.
 */

export interface Offer {
  id: string;
  workspaceId: string;
  name: string;
  company: string;
  description: string;
  primaryCta: string;
  bookingUrl: string;
  approvedCommercialFacts: Record<string, unknown>;
  approvedProductFacts: Record<string, unknown>;
  approvedClaims: string[];
  forbiddenClaims: string[];
  faq: Array<{ question: string; answer: string }>;
  objectionGuidance: Record<string, string>;
  toneConfig: Record<string, unknown>;
  active: boolean;
}

export type EngineType =
  | "maps_fast"
  | "maps_deep"
  | "google_serp"
  | "linkedin_owner"
  | "hybrid_fill";

export type CampaignStatus = "draft" | "active" | "paused" | "archived";

export interface DesiredChannelMix {
  email: number;
  sms: number;
}

export interface Campaign {
  id: string;
  workspaceId: string;
  offerId: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  countryCode: "ES";
  engineType: EngineType;
  engineConfig: Record<string, unknown>;
  dailySoftTarget: number;
  minimumFitScore: number | null;
  outreachProfileId: string | null;
  autopilotEnabled: boolean;
  desiredChannelMix: DesiredChannelMix;
  timeZone: string;
  createdAt: string;
  updatedAt: string;
}

export type CampaignMembershipStage =
  | "discovered"
  | "qualified"
  | "contact_selected"
  | "ready"
  | "contacted"
  | "rejected";

export interface CampaignMembership {
  id: string;
  campaignId: string;
  accountId: string;
  contactId: string | null;
  selectedContactPointId: string | null;
  stage: CampaignMembershipStage;
  rejectionReason: string | null;
  readyAt: string | null;
  contactedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
