import type { Account, AccountSource } from "@/domain/accounts/types";
import type { Contact, ContactPoint } from "@/domain/contacts/types";
import type { Campaign, Offer } from "@/domain/campaigns/types";
import type { EngineTargetState, GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";
import type { Mailbox, OutreachEvent, OutreachQueueItem, SendingDomain, SuppressionEntry } from "@/domain/outreach/types";

/**
 * Dev seed mode (Prompt 0 deliverable #5). In-memory, deterministic,
 * synthetic Spanish data so the UI shell has something real to render
 * without any external call or database. Phase 1 replaces this with a
 * Supabase-backed repository behind the same domain types — no UI code
 * should need to change when that happens.
 */

const now = () => new Date().toISOString();

export const seedOffer: Offer = {
  id: "offer_vitalcap",
  workspaceId: "ws_demo",
  name: "Vitalcap",
  company: "Vitalcap",
  description: "Suplementos para venta en farmacias y parafarmacias independientes.",
  primaryCta: "book_call_with_sales_director",
  bookingUrl: "https://example.com/configure-booking-url",
  approvedCommercialFacts: { pharmacy_share_pct: 51 },
  approvedProductFacts: {},
  approvedClaims: [],
  forbiddenClaims: ["therapeutic_claims", "guaranteed_sales_volume"],
  faq: [],
  objectionGuidance: {},
  toneConfig: { language: "es", tone: "professional_concise" },
  active: false,
};

export const seedCampaigns: Campaign[] = (
  [
    ["maps_fast", "Vitalcap - Pharmacies Spain - Maps Fast"],
    ["maps_deep", "Vitalcap - Maps Deep"],
    ["google_serp", "Vitalcap - Google SERP"],
    ["linkedin_owner", "Vitalcap - LinkedIn Owners"],
    ["hybrid_fill", "Vitalcap - Hybrid Fill"],
  ] as const
).map(([engineType, name]): Campaign => ({
  id: `campaign_${engineType}`,
  workspaceId: "ws_demo",
  offerId: seedOffer.id,
  name,
  description: null,
  status: "draft",
  countryCode: "ES",
  engineType,
  engineConfig: {},
  dailySoftTarget: 50,
  minimumFitScore: null,
  outreachProfileId: null,
  autopilotEnabled: false,
  desiredChannelMix: { email: 50, sms: 50 },
  timeZone: "Europe/Madrid",
  createdAt: now(),
  updatedAt: now(),
}));

interface SeedAccountBundle {
  account: Account;
  sources: AccountSource[];
  contacts: Contact[];
  contactPoints: ContactPoint[];
}

function account(partial: Partial<Account> & Pick<Account, "id" | "canonicalName" | "businessType">): Account {
  return {
    workspaceId: "ws_demo",
    normalizedName: partial.canonicalName.toLowerCase(),
    countryCode: "ES",
    region: null,
    province: null,
    city: null,
    postalCode: null,
    addressLine: null,
    normalizedAddress: null,
    latitude: null,
    longitude: null,
    phone: null,
    normalizedPhone: null,
    websiteUrl: null,
    normalizedDomain: null,
    googlePlaceId: null,
    mapsUrl: null,
    rating: null,
    reviewCount: null,
    fitScore: null,
    fitTier: "unscored",
    status: "outreach_ready",
    createdAt: now(),
    updatedAt: now(),
    ...partial,
  };
}

export const seedAccountBundles: SeedAccountBundle[] = [
  {
    account: account({
      id: "acc_1",
      canonicalName: "Farmacia Delgado",
      businessType: "pharmacy",
      province: "Sevilla",
      city: "Sevilla",
      websiteUrl: "https://farmaciadelgado.example.es",
      normalizedDomain: "farmaciadelgado.example.es",
      fitTier: "high",
      fitScore: 92,
    }),
    sources: [
      {
        id: "src_1a",
        accountId: "acc_1",
        sourceType: "maps_fast",
        sourceProvider: "mock_maps",
        sourceExternalId: "place_1",
        sourceUrl: null,
        rawSnapshot: {},
        discoveredAt: now(),
      },
    ],
    contacts: [
      {
        id: "ct_1_owner",
        workspaceId: "ws_demo",
        accountId: "acc_1",
        firstName: "Marta",
        lastName: "Delgado",
        fullName: "Marta Delgado",
        jobTitle: "Titular",
        roleType: "titular_pharmacist",
        isDecisionMaker: true,
        seniority: "owner",
        linkedinUrl: null,
        sourceConfidence: 0.9,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    contactPoints: [
      {
        id: "cp_1_owner",
        workspaceId: "ws_demo",
        accountId: "acc_1",
        contactId: "ct_1_owner",
        type: "email",
        value: "marta@farmaciadelgado.example.es",
        normalizedValue: "marta@farmaciadelgado.example.es",
        label: "owner",
        isGeneric: false,
        isPersonalOrNamed: true,
        priorityScore: 100,
        verificationStatus: "valid",
        verificationProvider: "mock_verifier",
        verificationCheckedAt: now(),
        channelEligibility: "eligible_email",
        sourceUrl: null,
        sourceType: "website",
        lastContactedAt: null,
        status: "eligible",
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: "cp_1_info",
        workspaceId: "ws_demo",
        accountId: "acc_1",
        contactId: null,
        type: "email",
        value: "info@farmaciadelgado.example.es",
        normalizedValue: "info@farmaciadelgado.example.es",
        label: "generic",
        isGeneric: true,
        isPersonalOrNamed: false,
        priorityScore: 60,
        verificationStatus: "valid",
        verificationProvider: "mock_verifier",
        verificationCheckedAt: now(),
        channelEligibility: "eligible_email",
        sourceUrl: null,
        sourceType: "website",
        lastContactedAt: null,
        status: "eligible",
        createdAt: now(),
        updatedAt: now(),
      },
    ],
  },
  {
    account: account({
      id: "acc_2",
      canonicalName: "Farmacia San Roque",
      businessType: "pharmacy",
      province: "Valencia",
      city: "Valencia",
      websiteUrl: "https://farmaciasanroque.example.es",
      normalizedDomain: "farmaciasanroque.example.es",
      fitTier: "medium",
      fitScore: 70,
    }),
    sources: [
      {
        id: "src_2a",
        accountId: "acc_2",
        sourceType: "maps_fast",
        sourceProvider: "mock_maps",
        sourceExternalId: "place_2",
        sourceUrl: null,
        rawSnapshot: {},
        discoveredAt: now(),
      },
    ],
    contacts: [],
    contactPoints: [
      {
        id: "cp_2_info",
        workspaceId: "ws_demo",
        accountId: "acc_2",
        contactId: null,
        type: "email",
        value: "info@farmaciasanroque.example.es",
        normalizedValue: "info@farmaciasanroque.example.es",
        label: "generic",
        isGeneric: true,
        isPersonalOrNamed: false,
        priorityScore: 60,
        verificationStatus: "valid",
        verificationProvider: "mock_verifier",
        verificationCheckedAt: now(),
        channelEligibility: "eligible_email",
        sourceUrl: null,
        sourceType: "website",
        lastContactedAt: null,
        status: "eligible",
        createdAt: now(),
        updatedAt: now(),
      },
    ],
  },
  {
    account: account({
      id: "acc_3",
      canonicalName: "Herbolario Naturvida",
      businessType: "herbal_shop",
      province: "Madrid",
      city: "Madrid",
      fitTier: "medium",
      fitScore: 65,
    }),
    sources: [
      {
        id: "src_3a",
        accountId: "acc_3",
        sourceType: "google_serp",
        sourceProvider: "mock_serp",
        sourceExternalId: null,
        sourceUrl: "https://search.example/naturvida",
        rawSnapshot: {},
        discoveredAt: now(),
      },
    ],
    contacts: [],
    contactPoints: [],
  },
  {
    account: account({
      id: "acc_4",
      canonicalName: "Sport Nutrition Barcelona",
      businessType: "sports_nutrition_store",
      province: "Barcelona",
      city: "Barcelona",
      fitTier: "medium",
      fitScore: 60,
    }),
    sources: [
      {
        id: "src_4a",
        accountId: "acc_4",
        sourceType: "maps_fast",
        sourceProvider: "mock_maps",
        sourceExternalId: "place_4",
        sourceUrl: null,
        rawSnapshot: {},
        discoveredAt: now(),
      },
    ],
    contacts: [],
    contactPoints: [],
  },
  {
    // Same pharmacy discovered by two engines — one account, two sources, no duplicate send.
    account: account({
      id: "acc_5",
      canonicalName: "Farmacia Central Bilbao",
      businessType: "pharmacy",
      province: "Bizkaia",
      city: "Bilbao",
      googlePlaceId: "place_5",
      fitTier: "high",
      fitScore: 88,
    }),
    sources: [
      {
        id: "src_5a",
        accountId: "acc_5",
        sourceType: "maps_fast",
        sourceProvider: "mock_maps",
        sourceExternalId: "place_5",
        sourceUrl: null,
        rawSnapshot: {},
        discoveredAt: now(),
      },
      {
        id: "src_5b",
        accountId: "acc_5",
        sourceType: "google_serp",
        sourceProvider: "mock_serp",
        sourceExternalId: null,
        sourceUrl: "https://search.example/farmacia-central-bilbao",
        rawSnapshot: {},
        discoveredAt: now(),
      },
    ],
    contacts: [
      {
        id: "ct_5_owner",
        workspaceId: "ws_demo",
        accountId: "acc_5",
        firstName: "Iker",
        lastName: "Zabala",
        fullName: "Iker Zabala",
        jobTitle: "Titular",
        roleType: "titular_pharmacist",
        isDecisionMaker: true,
        seniority: "owner",
        linkedinUrl: null,
        sourceConfidence: 0.85,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: "ct_5_manager",
        workspaceId: "ws_demo",
        accountId: "acc_5",
        firstName: "Naia",
        lastName: "Etxebarria",
        fullName: "Naia Etxebarria",
        jobTitle: "Gerente",
        roleType: "manager",
        isDecisionMaker: true,
        seniority: "senior",
        linkedinUrl: null,
        sourceConfidence: 0.7,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    contactPoints: [],
  },
  {
    // Invalid non-Spain record (Prompt 1 §1.9 / §1.4): SpainEligibilityService
    // rejects it outright on the provider country code — never silently
    // accepted, never promoted past `rejected_country`.
    account: account({
      id: "acc_6",
      canonicalName: "Farmacia Lisboa Centro",
      businessType: "pharmacy",
      countryCode: "PT",
      city: "Lisboa",
      status: "rejected_country",
      fitTier: "unscored",
      fitScore: null,
    }),
    sources: [
      {
        id: "src_6a",
        accountId: "acc_6",
        sourceType: "maps_fast",
        sourceProvider: "mock_maps",
        sourceExternalId: "place_6",
        sourceUrl: null,
        rawSnapshot: {},
        discoveredAt: now(),
      },
    ],
    contacts: [],
    contactPoints: [],
  },
];

export const seedEngineTargets: EngineTargetState[] = [
  {
    engineType: "maps_fast",
    softTarget: 50,
    readyToday: 60,
    rawQueueDepth: 34,
    processingQueueDepth: 6,
    currentYield: 0.41,
    providerHealth: "healthy",
    lastRunAt: now(),
    nextPlannedAction: "Continue rotating high-yield province seeds",
  },
  {
    engineType: "maps_deep",
    softTarget: 50,
    readyToday: 50,
    rawQueueDepth: 18,
    processingQueueDepth: 4,
    currentYield: 0.28,
    providerHealth: "healthy",
    lastRunAt: now(),
    nextPlannedAction: "Deepen owner search for high-fit accounts",
  },
  {
    engineType: "google_serp",
    softTarget: 50,
    readyToday: 63,
    rawQueueDepth: 21,
    processingQueueDepth: 3,
    currentYield: 0.52,
    providerHealth: "healthy",
    lastRunAt: now(),
    nextPlannedAction: "Expand to next-highest-yield province set",
  },
  {
    engineType: "linkedin_owner",
    softTarget: 50,
    readyToday: 27,
    rawQueueDepth: 15,
    processingQueueDepth: 9,
    currentYield: 0.14,
    providerHealth: "degraded",
    lastRunAt: now(),
    nextPlannedAction: "Waiting on SERP provider recovery",
  },
  {
    engineType: "hybrid_fill",
    softTarget: 50,
    readyToday: 50,
    rawQueueDepth: 0,
    processingQueueDepth: 0,
    currentYield: 0.6,
    providerHealth: "healthy",
    lastRunAt: now(),
    nextPlannedAction: "Standing by to absorb remaining deficit",
  },
];

export const seedRebalanceDecisions: RebalanceDecision[] = [
  { id: "rb_1", createdAt: now(), fromEngine: null, toEngine: "maps_fast", amount: 10, reason: "LinkedIn Owner behind target by 18 — allocated +10 to Maps Fast" },
  { id: "rb_2", createdAt: now(), fromEngine: null, toEngine: "google_serp", amount: 8, reason: "LinkedIn Owner behind target by 18 — allocated +8 to Google SERP" },
  { id: "rb_3", createdAt: now(), fromEngine: null, toEngine: "hybrid_fill", amount: 5, reason: "Hybrid Fill invoked to protect the 250 global daily target" },
];

export function getSeedGlobalAutopilotState(): GlobalAutopilotState {
  const readyToday = seedEngineTargets.reduce((sum, engine) => sum + engine.readyToday, 0);
  return {
    dailyTarget: 250,
    readyToday,
    sentToday: 0,
    repliesToday: 0,
    meetingsToday: 0,
    readyBufferDays: 4.2,
    systemHealth: seedEngineTargets.some((engine) => engine.providerHealth === "degraded") ? "degraded" : "healthy",
    engines: seedEngineTargets,
  };
}

/**
 * Outreach infrastructure seed data (Prompt 3 §3.10/§3.11): sending
 * domains, mailboxes, suppression entries and a small outreach queue/event
 * history so the Infrastructure and Outreach pages have real-shaped
 * synthetic data without any external provider or database.
 */

export const seedSendingDomains: SendingDomain[] = [
  { id: "dom_primary", domain: "outreach-vitalcap.example.com", status: "connected", warmupStatus: "warm" },
  { id: "dom_secondary", domain: "vc-mail.example.com", status: "degraded", warmupStatus: "warming" },
];

export const seedMailboxes: Mailbox[] = [
  { id: "mb_1", sendingDomainId: "dom_primary", email: "sales1@outreach-vitalcap.example.com", dailyCapacity: 30, sentToday: 11, bounceRate: 0.01, replyRate: 0.06, healthScore: 92, pausedReason: null },
  { id: "mb_2", sendingDomainId: "dom_primary", email: "sales2@outreach-vitalcap.example.com", dailyCapacity: 30, sentToday: 22, bounceRate: 0.02, replyRate: 0.04, healthScore: 85, pausedReason: null },
  { id: "mb_3", sendingDomainId: "dom_secondary", email: "hello@vc-mail.example.com", dailyCapacity: 20, sentToday: 5, bounceRate: 0.06, replyRate: 0.02, healthScore: 55, pausedReason: null },
  { id: "mb_4", sendingDomainId: "dom_secondary", email: "team@vc-mail.example.com", dailyCapacity: 20, sentToday: 0, bounceRate: 0.0, replyRate: 0.0, healthScore: 70, pausedReason: "Awaiting DNS warm-up completion" },
];

export const seedSuppressionEntries: SuppressionEntry[] = [
  { id: "sup_1", workspaceId: "ws_demo", contactPointId: "cp_2_info", accountId: null, reason: "unsubscribe", createdAt: now() },
  { id: "sup_2", workspaceId: "ws_demo", contactPointId: null, accountId: "acc_6", reason: "compliance_block", createdAt: now() },
];

export const seedOutreachQueueItems: OutreachQueueItem[] = [
  { id: "q_1", campaignId: "campaign_maps_fast", accountId: "acc_1", contactId: "ct_1_owner", contactPointId: "cp_1_owner", channel: "email", priority: 100, scheduledFor: now(), state: "sent", deliveryMode: "dry_run" },
  { id: "q_2", campaignId: "campaign_maps_fast", accountId: "acc_2", contactId: null, contactPointId: "cp_2_info", channel: "email", priority: 60, scheduledFor: now(), state: "suppressed", deliveryMode: "dry_run" },
  { id: "q_3", campaignId: "campaign_google_serp", accountId: "acc_5", contactId: "ct_5_owner", contactPointId: "cp_1_owner", channel: "email", priority: 100, scheduledFor: now(), state: "scheduled", deliveryMode: "dry_run" },
];

export const seedOutreachEvents: OutreachEvent[] = [
  { id: "evt_1", outreachQueueItemId: "q_1", state: "queued", providerEventId: null, payloadHash: null, occurredAt: now() },
  { id: "evt_2", outreachQueueItemId: "q_1", state: "sent", providerEventId: "mock_evt_1", payloadHash: null, occurredAt: now() },
  { id: "evt_3", outreachQueueItemId: "q_2", state: "suppressed", providerEventId: null, payloadHash: null, occurredAt: now() },
  { id: "evt_4", outreachQueueItemId: "q_3", state: "scheduled", providerEventId: null, payloadHash: null, occurredAt: now() },
];
