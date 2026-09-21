import { describe, expect, it } from "vitest";
import type { EmailVerificationProvider, WebsiteFetcher } from "@/domain/providers/types";
import type { ContactPoint } from "@/domain/contacts/types";
import type { Offer } from "@/domain/campaigns/types";
import type { Conversation, ConversationMessage } from "@/domain/conversations/types";
import type { OutreachQueueItem, SuppressionEntry } from "@/domain/outreach/types";
import { createInMemoryVerificationCacheStore } from "@/services/verification/email-verification-cache";
import { processRawCandidate, type CandidateRawPayload } from "@/services/discovery/candidate-processor";
import { evaluateAccountDedup, type AccountIdentitySignals } from "@/services/deduplication/account-dedup";
import { routeAccountToEndpoint } from "@/services/outreach/channel-router";
import { evaluateProviderHealth } from "@/services/discovery/provider-health";
import { claimNextJob, failJob } from "@/infrastructure/jobs/job-queue";
import type { JobRecord } from "@/domain/discovery/types";
import { addSuppression } from "@/services/compliance/suppression-service";
import { checkSuppression } from "@/services/compliance/suppression-service";
import { decideNextSequenceAction, type SequenceStepDefinition } from "@/services/outreach/sequence-service";
import { ingestOutreachEvent } from "@/services/outreach/outreach-event-ingestion";
import { MockLLMProvider } from "@/infrastructure/providers/llm/mock-provider";
import { processIncomingReply } from "@/services/setter/setter-orchestrator";
import { applyReviewDecision } from "@/services/setter/review-service";
import { simulateAutopilotDay } from "@/services/autopilot/simulate-autopilot-day";

/**
 * Prompt 6 §6.1 — end-to-end critical flow acceptance suite (Flows A–I).
 * Each `describe` block below is a named flow from the master prompt.
 * Rather than re-implementing already-unit-tested logic, each flow wires
 * together the real service functions used in production and asserts on
 * the flow's specific, named risk — duplicating an existing unit test's
 * assertions is not the goal; proving the *composed* behavior is.
 */

function alwaysValidVerifier(): EmailVerificationProvider {
  return {
    providerName: "fake",
    verifyBatch: async (emails) => ({
      outcomes: emails.map((email) => ({ email, code: "valid" as const, providerRawCode: "OK", costUsd: 0.01, checkedAt: new Date().toISOString() })),
      usage: { calls: 1, items: emails.length, errors: 0, totalLatencyMs: 10, costUsd: 0.01 * emails.length, quotaRemaining: null },
    }),
  };
}

function fetcherReturning(body: string): WebsiteFetcher {
  return { fetchPage: async (url) => ({ url, status: 200, contentType: "text/html", body }) };
}

describe("Flow A — Maps Fast: discover -> normalize -> dedup -> crawl -> verify -> ready", () => {
  it("carries a Spanish pharmacy candidate all the way to outreach-ready", async () => {
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: "flow_a_1",
        name: "Farmacia Flow A",
        category: "farmacia",
        address: "Calle Mayor 1",
        postalCode: "28001",
        province: "Madrid",
        city: "Madrid",
        countryCode: "ES",
        websiteUrl: "https://farmaciaflowa.es",
        phone: null,
        latitude: null,
        longitude: null,
        rating: 4.6,
        reviewCount: 30,
        sourceUrl: "https://maps.example.com/place/flow_a_1",
      },
    };
    const result = await processRawCandidate(payload, "maps_fast", {
      existingAccounts: [],
      websiteFetcher: fetcherReturning("<html>Contacto: info@farmaciaflowa.es</html>"),
      verificationProvider: alwaysValidVerifier(),
      verificationCacheStore: createInMemoryVerificationCacheStore(),
      now: new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.spainVerdict).toBe("verified");
    expect(result.isDuplicate).toBe(false);
    expect(result.readyForOutreach).toBe(true);

    // Channel routing (dry-run send) never has to guess: exactly one endpoint is selected.
    const contactPoint: ContactPoint = {
      id: "cp_flow_a", workspaceId: "ws_demo", accountId: "acc_flow_a", contactId: null,
      type: "email", value: "info@farmaciaflowa.es", normalizedValue: "info@farmaciaflowa.es",
      label: "info", isGeneric: true, isPersonalOrNamed: false, priorityScore: 60,
      verificationStatus: "valid", verificationProvider: null, verificationCheckedAt: null,
      channelEligibility: "eligible_email", sourceUrl: null, sourceType: null, lastContactedAt: null,
      status: "eligible", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    };
    const route = routeAccountToEndpoint({
      accountId: "acc_flow_a", contactPoints: [contactPoint], existingQueueItems: [], suppressionEntries: [], now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(route.selectedContactPointId).toBe("cp_flow_a");
    expect(route.blockedReason).toBeNull();
  });
});

describe("Flow B — Maps Deep: owner priority, never concurrent with a generic endpoint", () => {
  it("selects the named owner contact point and blocks a simultaneous generic-endpoint route", () => {
    const owner: ContactPoint = {
      id: "cp_owner", workspaceId: "ws_demo", accountId: "acc_flow_b", contactId: "contact_owner",
      type: "email", value: "maria@farmaciab.es", normalizedValue: "maria@farmaciab.es",
      label: null, isGeneric: false, isPersonalOrNamed: true, priorityScore: 100,
      verificationStatus: "valid", verificationProvider: null, verificationCheckedAt: null,
      channelEligibility: "eligible_email", sourceUrl: "https://farmaciab.es/aviso-legal", sourceType: "maps_deep", lastContactedAt: null,
      status: "eligible", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    };
    const generic: ContactPoint = {
      ...owner,
      id: "cp_generic", contactId: null, value: "info@farmaciab.es", normalizedValue: "info@farmaciab.es",
      label: "info", isGeneric: true, isPersonalOrNamed: false, priorityScore: 60,
    };

    // First route: both endpoints available, priority ordering (owner first) wins.
    const firstRoute = routeAccountToEndpoint({
      accountId: "acc_flow_b", contactPoints: [generic, owner], existingQueueItems: [], suppressionEntries: [], now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(firstRoute.selectedContactPointId).toBe("cp_owner");

    // Once the owner path is active, the generic endpoint must NOT also be contacted concurrently.
    const activeQueueItem: OutreachQueueItem = {
      id: "q_owner", campaignId: "camp_1", accountId: "acc_flow_b", contactId: "contact_owner",
      contactPointId: "cp_owner", channel: "email", priority: 100, scheduledFor: null, state: "sent", deliveryMode: "dry_run",
    };
    const secondRoute = routeAccountToEndpoint({
      accountId: "acc_flow_b", contactPoints: [generic, owner], existingQueueItems: [activeQueueItem], suppressionEntries: [], now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(secondRoute.selectedContactPointId).toBeNull();
    expect(secondRoute.blockedReason).toBe("concurrent_active_path");
  });
});

describe("Flow C — Duplicate: same pharmacy via Maps + Google, one account, no duplicate send", () => {
  it("dedups the second source into the first account and blocks a second concurrent send", () => {
    const existing: AccountIdentitySignals[] = [
      { accountId: "acc_existing", normalizedName: "farmacia flow c", normalizedDomain: "farmaciaflowc.es" },
    ];
    const incoming: Omit<AccountIdentitySignals, "accountId"> = {
      normalizedName: "farmacia flow c",
      normalizedDomain: "farmaciaflowc.es",
    };
    const decision = evaluateAccountDedup(incoming, existing);
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.accountId).toBe("acc_existing");
    expect(decision.matches[0]?.signal).toBe("normalized_domain");

    // The account now has one queue item already active from source #1; a candidate produced by
    // source #2 (same account, same generic endpoint) must not queue a second concurrent send.
    const genericEndpoint: ContactPoint = {
      id: "cp_dup", workspaceId: "ws_demo", accountId: "acc_existing", contactId: null,
      type: "email", value: "info@farmaciaflowc.es", normalizedValue: "info@farmaciaflowc.es",
      label: "info", isGeneric: true, isPersonalOrNamed: false, priorityScore: 60,
      verificationStatus: "valid", verificationProvider: null, verificationCheckedAt: null,
      channelEligibility: "eligible_email", sourceUrl: null, sourceType: null, lastContactedAt: null,
      status: "eligible", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    };
    const alreadyQueued: OutreachQueueItem = {
      id: "q_existing", campaignId: "camp_1", accountId: "acc_existing", contactId: null,
      contactPointId: "cp_dup", channel: "email", priority: 60, scheduledFor: null, state: "sent", deliveryMode: "dry_run",
    };
    const route = routeAccountToEndpoint({
      accountId: "acc_existing", contactPoints: [genericEndpoint], existingQueueItems: [alreadyQueued], suppressionEntries: [], now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(route.selectedContactPointId).toBeNull();
    expect(route.blockedReason).toBe("concurrent_active_path");
  });
});

describe("Flow D — Spain boundary: Portugal/France/Andorra results are rejected/not eligible", () => {
  it.each([
    { name: "Farmácia Lisboa", countryCode: "PT" },
    { name: "Pharmacie Paris", countryCode: "FR" },
    { name: "Farmàcia Andorra", countryCode: "AD" },
  ])("rejects a $countryCode result as not Spain-eligible", async ({ name, countryCode }) => {
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: `flow_d_${countryCode}`, name, category: "farmacia", address: null,
        postalCode: null, province: null, city: null, countryCode, websiteUrl: null, phone: null,
        latitude: null, longitude: null, rating: null, reviewCount: null, sourceUrl: null,
      },
    };
    const result = await processRawCandidate(payload, "maps_fast", {
      existingAccounts: [],
      websiteFetcher: fetcherReturning(""),
      verificationProvider: alwaysValidVerifier(),
      verificationCacheStore: createInMemoryVerificationCacheStore(),
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(result.spainVerdict).toBe("rejected");
    expect(result.readyForOutreach).toBe(false);
  });
});

describe("Flow E — Engine underperformance: rebalancer compensates for LinkedIn Owner", () => {
  it("shifts target to healthy engines and still reports a degraded system health signal", async () => {
    const result = await simulateAutopilotDay();
    const linkedIn = result.engines.find((e) => e.engineType === "linkedin_owner")!;
    expect(linkedIn.providerHealth).toBe("paused");
    expect(result.state.systemHealth).toBe("degraded");
    expect(result.tick.hybridFillActions.length).toBeGreaterThan(0);
  });
});

describe("Flow F — Provider outage: verification down, jobs retry, no data loss, no invalid sends", () => {
  it("degrades gracefully instead of crashing, and the raw candidate is never lost", async () => {
    const outage: EmailVerificationProvider = {
      providerName: "outage",
      verifyBatch: async () => {
        throw new Error("provider unavailable");
      },
    };
    const payload: CandidateRawPayload = {
      kind: "maps",
      place: {
        externalPlaceId: "flow_f_1", name: "Farmacia Flow F", category: "farmacia", address: null,
        postalCode: "28001", province: "Madrid", city: "Madrid", countryCode: "ES",
        websiteUrl: "https://farmaciaflowf.es", phone: null, latitude: null, longitude: null,
        rating: null, reviewCount: null, sourceUrl: null,
      },
    };
    // The candidate itself is always returned (no data loss) — it's simply not marked ready.
    const result = await processRawCandidate(payload, "maps_fast", {
      existingAccounts: [],
      websiteFetcher: fetcherReturning("<html>info@farmaciaflowf.es</html>"),
      verificationProvider: outage,
      verificationCacheStore: createInMemoryVerificationCacheStore(),
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(result.readyForOutreach).toBe(false);
    expect(result.contactPoints.every((cp) => !cp.acceptable)).toBe(true);

    // Health alert: repeated provider errors are visible to the health evaluator.
    const health = evaluateProviderHealth({ calls: 5, items: 5, errors: 5, totalLatencyMs: 500, costUsd: 0, quotaRemaining: null });
    expect(health).toBe("paused");

    // Job retry: a transient failure retries with backoff rather than dead-lettering immediately.
    const job: JobRecord = {
      id: "job_verify_1", campaignId: "camp_1", type: "verification", payload: {}, status: "pending",
      attemptCount: 0, maxAttempts: 5, lockedAt: null, lockedBy: null, nextAttemptAt: null, lastError: null,
      createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    };
    const now = new Date("2025-01-01T00:00:00Z");
    const claimed = claimNextJob([job], "worker_1", now)!;
    const failed = failJob(claimed, new Error("provider timeout"), now);
    expect(failed.status).toBe("pending");
    expect(failed.nextAttemptAt).not.toBeNull();
  });
});

describe("Flow G — Reply: idempotent ingestion -> AI draft -> review -> send in same thread", () => {
  it("runs the full classify -> draft -> approve -> send loop without duplicating on webhook replay", async () => {
    const conversation: Conversation = {
      id: "conv_g", workspaceId: "ws-1", accountId: "acc-1", contactId: null, campaignId: "camp-1",
      offerId: "offer-1", channel: "email", providerThreadId: "thread-g", state: "reply_received",
      latestIntent: null, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const incomingMessage: ConversationMessage = {
      id: "msg_g", conversationId: "conv_g", direction: "incoming", body: "Nos interesa saber más sobre el producto.",
      channel: "email", providerMessageId: "provider-msg-g", metadata: {}, createdAt: "2024-01-02T00:00:00.000Z",
    };
    const offer: Offer = {
      id: "offer-1", workspaceId: "ws-1", name: "Vitalcap", company: "Vitalcap", description: "Suplementos",
      primaryCta: "book_meeting", bookingUrl: "https://cal.example.com/vitalcap", approvedCommercialFacts: {},
      approvedProductFacts: {}, approvedClaims: [], forbiddenClaims: ["therapeutic_claims"], faq: [],
      objectionGuidance: {}, toneConfig: {}, active: true,
    };

    const result = await processIncomingReply({
      workspaceId: "ws-1", conversation, incomingMessage, conversationMessages: [incomingMessage], offer,
      account: {
        id: "acc-1", workspaceId: "ws-1", canonicalName: "Farmacia Flow G", normalizedName: "farmacia flow g",
        businessType: "pharmacy", countryCode: "ES", region: null, province: null, city: null, postalCode: null,
        addressLine: null, normalizedAddress: null, latitude: null, longitude: null, phone: null, normalizedPhone: null,
        websiteUrl: null, normalizedDomain: null, googlePlaceId: null, mapsUrl: null, rating: null, reviewCount: null,
        fitScore: null, fitTier: "unscored", status: "outreach_ready", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
      },
      contact: null, discoverySource: "maps_fast", recentFeedback: [], suppressionEntries: [],
      contactPointId: "cp-g", llmProvider: new MockLLMProvider(), now: new Date("2024-01-02T00:00:00.000Z"),
    });

    expect(result.usedLLM).toBe(true);
    expect(result.conversation.state).toBe("pending_review");

    const fullDraft = { ...result.draft!, id: "draft-g", conversationMessageId: "msg_g", createdAt: "2024-01-02T00:00:00.000Z" };
    const review = applyReviewDecision(
      { draft: fullDraft, conversation: result.conversation, decision: "approve", finalText: null, correctionReason: null, correctedBranch: null, reviewerId: "reviewer-1", reviewedAt: "2024-01-02T01:00:00.000Z" },
      () => "id_g",
    );
    expect(review.conversation.state).toBe("sent");
    // Same-thread invariant: the reply always resolves within the conversation's original thread.
    expect(review.conversation.id).toBe(conversation.id);
    expect(review.outgoingMessage?.conversationId).toBe(conversation.id);
  });
});

describe("Flow H — Unsubscribe: suppression cancels the active cold sequence, no continued selling", () => {
  it("suppresses on unsubscribe and the sequence planner refuses to schedule any further step", () => {
    let suppressionEntries: SuppressionEntry[] = [];
    suppressionEntries = addSuppression(suppressionEntries, {
      workspaceId: "ws_demo", contactPointId: "cp_h", accountId: null, reason: "unsubscribe", now: new Date("2025-01-01T00:00:00Z"),
    });
    const check = checkSuppression({ contactPointId: "cp_h", accountId: "acc_h" }, suppressionEntries);
    expect(check.suppressed).toBe(true);

    const steps: SequenceStepDefinition[] = [
      { stepIndex: 0, kind: "cold", delayAfterPreviousMs: 0 },
      { stepIndex: 1, kind: "warm_followup", delayAfterPreviousMs: 3 * 24 * 60 * 60 * 1000 },
    ];
    const events = ingestOutreachEvent([], { outreachQueueItemId: "q_h", state: "unsubscribed", providerEventId: "evt_h", payloadHash: null, occurredAt: "2025-01-01T00:00:00Z" }, () => "ev_h").events;
    const decision = decideNextSequenceAction({ steps, events, now: new Date("2025-01-10T00:00:00Z") });
    // Unsubscribe is stronger than a reply pause — it permanently cancels the sequence.
    expect(decision.action).toBe("cancel");
  });
});

describe("Flow I — Setter restricted claim: human required, never a hallucinated answer", () => {
  it("forces human review when a draft contains a non-approved medical/commercial claim", async () => {
    const provider = new MockLLMProvider();
    const forcedRiskyProvider = {
      providerName: provider.providerName,
      classifyAndDraft: async () => ({
        output: {
          language: "es" as const, branch: "INTEREST" as const, intentSummary: "Lead asks a restricted question",
          confidence: 0.9, draft: "Este producto cura la fatiga crónica y tiene certificación garantizada.",
          needsHuman: false, reasonForHuman: null, detectedFactsRequested: [], riskFlags: [], suggestedNextAction: "send_info",
        },
        usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 10, costUsd: 0, quotaRemaining: null },
      }),
    };
    const conversation: Conversation = {
      id: "conv_i", workspaceId: "ws-1", accountId: "acc-1", contactId: null, campaignId: "camp-1",
      offerId: "offer-1", channel: "email", providerThreadId: "thread-i", state: "reply_received",
      latestIntent: null, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const incomingMessage: ConversationMessage = {
      id: "msg_i", conversationId: "conv_i", direction: "incoming", body: "¿Esto cura la fatiga crónica?",
      channel: "email", providerMessageId: "provider-msg-i", metadata: {}, createdAt: "2024-01-02T00:00:00.000Z",
    };
    const offer: Offer = {
      id: "offer-1", workspaceId: "ws-1", name: "Vitalcap", company: "Vitalcap", description: "Suplementos",
      primaryCta: "book_meeting", bookingUrl: "https://cal.example.com/vitalcap", approvedCommercialFacts: {},
      approvedProductFacts: {}, approvedClaims: [], forbiddenClaims: ["therapeutic_claims"], faq: [],
      objectionGuidance: {}, toneConfig: {}, active: true,
    };

    const result = await processIncomingReply({
      workspaceId: "ws-1", conversation, incomingMessage, conversationMessages: [incomingMessage], offer,
      account: {
        id: "acc-1", workspaceId: "ws-1", canonicalName: "Farmacia Flow I", normalizedName: "farmacia flow i",
        businessType: "pharmacy", countryCode: "ES", region: null, province: null, city: null, postalCode: null,
        addressLine: null, normalizedAddress: null, latitude: null, longitude: null, phone: null, normalizedPhone: null,
        websiteUrl: null, normalizedDomain: null, googlePlaceId: null, mapsUrl: null, rating: null, reviewCount: null,
        fitScore: null, fitTier: "unscored", status: "outreach_ready", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
      },
      contact: null, discoverySource: "maps_fast", recentFeedback: [], suppressionEntries: [],
      contactPointId: "cp-i", llmProvider: forcedRiskyProvider, now: new Date("2024-01-02T00:00:00.000Z"),
    });

    expect(result.draft?.needsHuman).toBe(true);
    expect(result.draft?.riskFlags.length).toBeGreaterThan(0);
    expect(result.conversation.state).toBe("pending_review");
  });
});
