/**
 * Provider adapter contracts (Prompt 2 §2.1, §2.7, §2.13). Pure interfaces
 * only — no framework or infrastructure imports, no hard-coded provider
 * choice. Concrete adapters (real or mock) live in `infrastructure/providers/*`
 * and implement these shapes; services depend on the interface, never the
 * concrete adapter, per `docs/ARCHITECTURE.md` layering rule.
 */

export interface ProviderUsageStats {
  calls: number;
  items: number;
  errors: number;
  totalLatencyMs: number;
  costUsd: number;
  quotaRemaining: number | null;
}

export function emptyProviderUsageStats(): ProviderUsageStats {
  return { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null };
}

export interface MapsPlaceResult {
  externalPlaceId: string;
  name: string;
  category: string | null;
  address: string | null;
  postalCode: string | null;
  province: string | null;
  city: string | null;
  countryCode: string | null;
  websiteUrl: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviewCount: number | null;
  sourceUrl: string | null;
}

export interface MapsSearchInput {
  query: string;
  geography: string;
  pageToken: string | null;
}

export interface MapsSearchOutput {
  results: MapsPlaceResult[];
  nextPageToken: string | null;
  usage: ProviderUsageStats;
}

export interface MapsDiscoveryProvider {
  readonly providerName: string;
  search(input: MapsSearchInput): Promise<MapsSearchOutput>;
}

export interface SerpResult {
  title: string;
  url: string;
  snippet: string;
  domain: string | null;
}

export interface SerpSearchInput {
  query: string;
  maxResults: number;
}

export interface SerpSearchOutput {
  results: SerpResult[];
  usage: ProviderUsageStats;
}

export interface SerpDiscoveryProvider {
  readonly providerName: string;
  search(input: SerpSearchInput): Promise<SerpSearchOutput>;
}

export type EmailVerificationCode = "valid" | "catch_all" | "risky" | "invalid" | "unknown" | "disposable";

export interface EmailVerificationOutcome {
  email: string;
  code: EmailVerificationCode;
  providerRawCode: string;
  costUsd: number;
  checkedAt: string;
}

export interface EmailVerificationProvider {
  readonly providerName: string;
  /** Supports batching per §2.7 — always accepts an array, even for a single email. */
  verifyBatch(emails: readonly string[]): Promise<{ outcomes: EmailVerificationOutcome[]; usage: ProviderUsageStats }>;
}

/**
 * Email delivery provider contract (Prompt 3 §3.3). Primary production
 * adapter may be Instantly if configured, but no Instantly campaign ID is
 * ever hard-coded — the internal-campaign → provider-campaign-ID mapping is
 * caller-supplied configuration, never baked into this interface or an
 * adapter.
 */
export interface EmailLeadInput {
  providerCampaignId: string;
  email: string;
  customVariables: Record<string, string>;
  /** Ask the provider to no-op instead of duplicating a lead it already has. */
  skipIfExisting: boolean;
}

export type EmailLeadAddStatus = "added" | "skipped_existing";

export interface EmailLeadResult {
  providerLeadId: string;
  status: EmailLeadAddStatus;
}

export type EmailDeliveryStatusCode = "sent" | "delivered" | "bounced" | "replied" | "unsubscribed" | "failed";

export interface EmailDeliveryStatusEvent {
  providerLeadId: string;
  providerEventId: string;
  code: EmailDeliveryStatusCode;
  occurredAt: string;
  raw: Record<string, unknown>;
}

export interface EmailDeliveryProvider {
  readonly providerName: string;
  addLead(input: EmailLeadInput): Promise<{ result: EmailLeadResult; usage: ProviderUsageStats }>;
  /** Polls (or, in a real adapter, is fed by a webhook) provider-side status changes since a point in time. */
  syncStatus(providerCampaignId: string, since: Date): Promise<{ events: EmailDeliveryStatusEvent[]; usage: ProviderUsageStats }>;
}

/**
 * SMS delivery provider contract (Prompt 3 §3.5). A concrete adapter for an
 * undocumented vendor (e.g. Textvy) must never be built against a guessed
 * API — until official docs are available, only this interface + a mock
 * adapter exist (see `docs/PROVIDERS.md`).
 */
export interface SmsSendInput {
  fromSenderId: string;
  toE164: string;
  body: string;
}

export interface SmsSendResult {
  providerMessageId: string;
  segments: number;
  costUsd: number;
}

export type SmsDeliveryStatusCode = "sent" | "delivered" | "failed" | "replied" | "opted_out";

export interface SmsDeliveryStatusEvent {
  providerMessageId: string;
  providerEventId: string;
  code: SmsDeliveryStatusCode;
  failureCode: string | null;
  occurredAt: string;
  raw: Record<string, unknown>;
}

export interface SmsDeliveryProvider {
  readonly providerName: string;
  send(input: SmsSendInput): Promise<{ result: SmsSendResult; usage: ProviderUsageStats }>;
  syncStatus(since: Date): Promise<{ events: SmsDeliveryStatusEvent[]; usage: ProviderUsageStats }>;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
}

export interface WebsiteFetcher {
  fetchPage(url: string): Promise<FetchedPage>;
}

/**
 * AI Setter LLM contract (Prompt 4 §4.4/§4.5). The provider receives only a
 * pre-built, whitelisted context object (never a raw DB dump) and must
 * return the exact structured shape below — the caller re-validates the
 * response with Zod regardless of what the provider claims to guarantee.
 */
export interface SetterPromptContext {
  language: string;
  offer: {
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
  };
  account: { name: string; businessType: string };
  contact: { roleType: string; firstName: string | null } | null;
  discoverySource: string | null;
  recentMessages: Array<{ direction: "incoming" | "outgoing"; body: string }>;
  recentFeedbackNotes: string[];
  latestIncomingMessage: string;
  isRepairAttempt: boolean;
}

export interface SetterClassificationOutput {
  language: string;
  branch: string;
  intentSummary: string;
  confidence: number;
  draft: string;
  needsHuman: boolean;
  reasonForHuman: string | null;
  detectedFactsRequested: string[];
  riskFlags: string[];
  suggestedNextAction: string;
}

export interface LLMProvider {
  readonly providerName: string;
  classifyAndDraft(context: SetterPromptContext): Promise<{ output: SetterClassificationOutput; usage: ProviderUsageStats }>;
}
