import type { Account, AccountSource } from "@/domain/accounts/types";
import type { Contact, ContactPoint } from "@/domain/contacts/types";
import type { Campaign, Offer } from "@/domain/campaigns/types";
import type { Conversation, ConversationMessage, Meeting, SetterDraft, SetterFeedback } from "@/domain/conversations/types";
import type { EngineTargetState, GlobalAutopilotState, RebalanceDecision } from "@/domain/autopilot/types";
import type { Mailbox, OutreachEvent, OutreachQueueItem, SendingDomain, SuppressionEntry } from "@/domain/outreach/types";
import type { SearchSeed } from "@/domain/discovery/types";
import type { ProviderUsageStats } from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

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

/**
 * AI Setter seed data (Prompt 4 §4.1/§4.7/§4.8/§4.11): a small set of
 * conversations at different points in the review pipeline so the Reviews
 * inbox and Setter dashboard have real-shaped synthetic data.
 */

export const seedConversations: Conversation[] = [
  {
    id: "conv_1",
    workspaceId: "ws_demo",
    accountId: "acc_1",
    contactId: "ct_1_owner",
    campaignId: "campaign_maps_fast",
    offerId: seedOffer.id,
    channel: "email",
    providerThreadId: "instantly_thread_1",
    state: "pending_review",
    latestIntent: "PRICE",
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "conv_2",
    workspaceId: "ws_demo",
    accountId: "acc_5",
    contactId: "ct_5_owner",
    campaignId: "campaign_google_serp",
    offerId: seedOffer.id,
    channel: "email",
    providerThreadId: "instantly_thread_2",
    state: "sent",
    latestIntent: "MEETING_REQUEST",
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "conv_3",
    workspaceId: "ws_demo",
    accountId: "acc_2",
    contactId: null,
    campaignId: "campaign_maps_fast",
    offerId: seedOffer.id,
    channel: "email",
    providerThreadId: "instantly_thread_3",
    state: "suppressed",
    latestIntent: "UNSUBSCRIBE",
    createdAt: now(),
    updatedAt: now(),
  },
];

export const seedConversationMessages: ConversationMessage[] = [
  { id: "cmsg_1", conversationId: "conv_1", direction: "incoming", body: "Hola, ¿qué precio tienen para pedidos de farmacia?", channel: "email", providerMessageId: "instantly_msg_1", metadata: {}, createdAt: now() },
  { id: "cmsg_2", conversationId: "conv_2", direction: "incoming", body: "Nos interesa, ¿podemos agendar una llamada?", channel: "email", providerMessageId: "instantly_msg_2", metadata: {}, createdAt: now() },
  { id: "cmsg_3", conversationId: "conv_2", direction: "outgoing", body: "Perfecto, encantados de coordinar. ¿Le viene bien que agendemos una breve llamada con nuestro director comercial?", channel: "email", providerMessageId: null, metadata: { reviewDecision: "approve" }, createdAt: now() },
  { id: "cmsg_4", conversationId: "conv_3", direction: "incoming", body: "Por favor, dadme de baja de esta lista.", channel: "email", providerMessageId: "instantly_msg_3", metadata: {}, createdAt: now() },
];

export const seedSetterDrafts: SetterDraft[] = [
  {
    id: "draft_1",
    conversationMessageId: "cmsg_1",
    language: "es",
    branch: "PRICE",
    intentSummary: "Lead message classified as PRICE",
    confidence: 0.82,
    draft: "Gracias por su interés. Para compartir precios y condiciones concretas, lo mejor es una breve llamada. ¿Le viene bien que agendemos una breve llamada con nuestro director comercial? https://example.com/configure-booking-url",
    needsHuman: false,
    reasonForHuman: null,
    detectedFactsRequested: ["price"],
    riskFlags: [],
    suggestedNextAction: "await_human_review",
    createdAt: now(),
  },
];

export const seedSetterFeedback: SetterFeedback[] = [
  {
    id: "fb_1",
    conversationMessageId: "cmsg_2",
    predictedBranch: "MEETING_REQUEST",
    correctedBranch: null,
    aiDraft: "Perfecto, encantados de coordinar. ¿Le viene bien que agendemos una breve llamada con nuestro director comercial?",
    correctedText: null,
    decision: "approve",
    reasonCategory: null,
    note: null,
    meetingOutcome: "qualified",
    qualified: true,
    lostReason: null,
    reviewedAt: now(),
    reviewerId: "reviewer_demo",
  },
];

export const seedMeetings: Meeting[] = [
  { id: "meeting_1", conversationId: "conv_2", scheduledFor: now(), bookingUrl: seedOffer.bookingUrl, createdAt: now() },
];

/**
 * Dashboard weekly trend seed (Prompt 5 §5.3 "weekly reply/meeting trend").
 * Deterministic via the shared `hashString`/`seededRandom` fixture pattern
 * (Phase 2) so the trend is stable across renders/tests, not pure noise.
 */
export interface WeeklyTrendPoint {
  label: string;
  replies: number;
  meetings: number;
}

export const seedWeeklyTrend: WeeklyTrendPoint[] = (
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
).map((label, index) => {
  const rand = seededRandom(hashString(`weekly-trend-${label}-${index}`));
  return {
    label,
    replies: 3 + Math.round(rand() * 9),
    meetings: Math.round(rand() * 3),
  };
});

/**
 * Infrastructure/dashboard provider status rows (Prompt 3 §3.10, Prompt 5
 * §5.13). Shared between `/infrastructure` and the dashboard activity rail
 * so the two screens never disagree about provider health.
 */
export type ProviderRowStatus = "connected" | "degraded" | "paused" | "missing_configuration";

export const seedProviderRows: Array<{ name: string; status: ProviderRowStatus; detail: string }> = [
  { name: "Email delivery (Instantly)", status: "connected", detail: "Mock adapter active — no live API key configured" },
  { name: "SMS delivery", status: "connected", detail: "Mock adapter active — no live API key configured" },
  { name: "Email verification", status: "connected", detail: "Mock adapter active" },
  { name: "Maps discovery", status: "connected", detail: "Mock adapter active" },
  { name: "Google SERP", status: "connected", detail: "Mock adapter active" },
  { name: "LLM (setter drafts)", status: "connected", detail: "Mock adapter active (MockLLMProvider) — no real LLM API key configured" },
  { name: "Outreach webhooks", status: "connected", detail: "Signature verification enforced (HMAC-SHA256)" },
];

export const seedEmailVerificationUsage: ProviderUsageStats = {
  calls: 182,
  items: 640,
  errors: 3,
  totalLatencyMs: 91000,
  costUsd: 6.4,
  quotaRemaining: 120,
};

/**
 * Discovery search-seed catalog (Prompt 2 §2.4 `SearchSeed`, Prompt 5 §5.6).
 * A small, varied set of query/geography pairs per engine spanning
 * high-yield, average and exhausted/low-yield seeds.
 */
export const seedSearchSeeds: SearchSeed[] = [
  { id: "seed_1", campaignId: "campaign_maps_fast", engineType: "maps_fast", query: "farmacia", geography: "Sevilla", lastRunAt: now(), totalRaw: 210, totalUnique: 165, totalReady: 98, yieldRate: 0.59, exhaustionScore: 0.2, nextEligibleAt: null },
  { id: "seed_2", campaignId: "campaign_maps_fast", engineType: "maps_fast", query: "farmacia", geography: "Madrid", lastRunAt: now(), totalRaw: 340, totalUnique: 240, totalReady: 121, yieldRate: 0.5, exhaustionScore: 0.35, nextEligibleAt: null },
  { id: "seed_3", campaignId: "campaign_maps_deep", engineType: "maps_deep", query: "parafarmacia", geography: "Valencia", lastRunAt: now(), totalRaw: 95, totalUnique: 80, totalReady: 22, yieldRate: 0.28, exhaustionScore: 0.55, nextEligibleAt: null },
  { id: "seed_4", campaignId: "campaign_google_serp", engineType: "google_serp", query: "tienda nutrición deportiva", geography: "Barcelona", lastRunAt: now(), totalRaw: 130, totalUnique: 110, totalReady: 57, yieldRate: 0.52, exhaustionScore: 0.15, nextEligibleAt: null },
  { id: "seed_5", campaignId: "campaign_linkedin_owner", engineType: "linkedin_owner", query: "titular farmacia", geography: "Bizkaia", lastRunAt: now(), totalRaw: 40, totalUnique: 33, totalReady: 5, yieldRate: 0.14, exhaustionScore: 0.82, nextEligibleAt: null },
  { id: "seed_6", campaignId: "campaign_maps_fast", engineType: "maps_fast", query: "herbolario", geography: "Málaga", lastRunAt: now(), totalRaw: 60, totalUnique: 48, totalReady: 4, yieldRate: 0.08, exhaustionScore: 0.94, nextEligibleAt: null },
];

/**
 * Job queue health snapshot (Prompt 2 §2.12 `evaluateQueueHealth` shape,
 * Prompt 5 §5.5 Autopilot bottom section) — a static, plausible snapshot
 * rather than a full `JobRecord[]` fixture, since only the aggregate
 * numbers are rendered on the Autopilot page.
 */
export const seedQueueHealth = {
  pendingCount: 34,
  processingCount: 6,
  deadLetterCount: 2,
  oldestPendingAgeMs: 12 * 60 * 1000,
  stuckProcessingCount: 0,
  healthy: true,
};

export interface DeadLetterSample {
  id: string;
  jobType: string;
  reason: string;
  failedAt: string;
}

export const seedDeadLetterSamples: DeadLetterSample[] = [
  { id: "dlq_1", jobType: "verify_contact_point", reason: "unauthorized: provider quota exhausted", failedAt: now() },
  { id: "dlq_2", jobType: "send_outreach_message", reason: "permanent bounce: mailbox does not exist", failedAt: now() },
];

