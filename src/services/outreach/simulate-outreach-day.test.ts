import { describe, expect, it } from "vitest";
import type { Offer } from "@/domain/campaigns/types";
import type { ContactPoint } from "@/domain/contacts/types";
import type { Mailbox, OutreachEvent, OutreachQueueItem, SendingDomain, SuppressionEntry } from "@/domain/outreach/types";
import { decideNextSequenceAction, type SequenceStepDefinition } from "./sequence-service";
import { ingestOutreachEvent } from "./outreach-event-ingestion";
import { addSuppression } from "@/services/compliance/suppression-service";
import { runOutreachDryRunCycle } from "./outreach-orchestrator";

/**
 * Integration test for the Phase 3 dry-run outreach cycle, mirroring Phase
 * 2's `simulate-autopilot-day.ts` shape: exercise the full composed flow
 * over synthetic in-memory data (no real Supabase/provider calls), asserting
 * on the three highest-risk behaviors from Prompt 3 §3.7–§3.9/§3.12.
 */

function offer(): Offer {
  return {
    id: "offer_1",
    workspaceId: "ws_demo",
    name: "Demo Offer",
    company: "VitalCap",
    description: "Suplementos",
    primaryCta: "Reserva",
    bookingUrl: "https://cal.com/demo",
    approvedCommercialFacts: {},
    approvedProductFacts: {},
    approvedClaims: [],
    forbiddenClaims: [],
    faq: [],
    objectionGuidance: {},
    toneConfig: {},
    active: true,
  };
}

function contactPoint(overrides: Partial<ContactPoint> = {}): ContactPoint {
  return {
    id: "cp_1",
    workspaceId: "ws_demo",
    accountId: "acc_1",
    contactId: null,
    type: "email",
    value: "owner@example.es",
    normalizedValue: "owner@example.es",
    label: "owner",
    isGeneric: false,
    isPersonalOrNamed: true,
    priorityScore: 100,
    verificationStatus: "valid",
    verificationProvider: null,
    verificationCheckedAt: null,
    channelEligibility: "eligible_email",
    sourceUrl: null,
    sourceType: null,
    lastContactedAt: null,
    status: "eligible",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function domain(): SendingDomain {
  return { id: "dom_1", domain: "example.com", status: "connected", warmupStatus: "warm" };
}

function mailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "mb_1",
    sendingDomainId: "dom_1",
    email: "sales@example.com",
    dailyCapacity: 50,
    sentToday: 0,
    bounceRate: 0.01,
    replyRate: 0.05,
    healthScore: 90,
    pausedReason: null,
    ...overrides,
  };
}

describe("simulate outreach day (dry-run)", () => {
  it("schedules a dry-run send, never invoking any real delivery provider", async () => {
    const result = await runOutreachDryRunCycle({
      candidates: [
        { accountId: "acc_1", campaignId: "camp_1", contactPoints: [contactPoint()], contactFirstName: "Ana", accountName: "Farmacia Central" },
      ],
      existingQueueItems: [],
      suppressionEntries: [],
      desiredMix: { email: 125, sms: 125 },
      sentTodayByChannel: { email: 0, sms: 0 },
      mailboxes: [mailbox()],
      sendingDomains: [domain()],
      smsRemainingCapacity: 125,
      offer: offer(),
      messageTemplate: "Hola {{contact_first_name}}, {{offer_primary_cta}}",
      now: new Date("2025-06-01T09:00:00Z"),
      generateId: (() => {
        let i = 0;
        return () => `id_${i++}`;
      })(),
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.outcome).toBe("scheduled");
    expect(result.newQueueItems[0]?.deliveryMode).toBe("dry_run");
    expect(result.newQueueItems[0]?.state).toBe("scheduled");
    expect(result.results[0]?.renderedBody).toBe("Hola Ana, Reserva");
  });

  it("a bounce webhook event adds the contact to suppression and future cycles skip it", async () => {
    let suppressionEntries: SuppressionEntry[] = [];
    suppressionEntries = addSuppression(suppressionEntries, {
      workspaceId: "ws_demo",
      contactPointId: "cp_1",
      accountId: null,
      reason: "permanent_bounce",
      now: new Date("2025-06-01T10:00:00Z"),
    });

    const result = await runOutreachDryRunCycle({
      candidates: [
        { accountId: "acc_1", campaignId: "camp_1", contactPoints: [contactPoint()], contactFirstName: "Ana", accountName: "Farmacia Central" },
      ],
      existingQueueItems: [],
      suppressionEntries,
      desiredMix: { email: 125, sms: 125 },
      sentTodayByChannel: { email: 0, sms: 0 },
      mailboxes: [mailbox()],
      sendingDomains: [domain()],
      smsRemainingCapacity: 125,
      offer: offer(),
      messageTemplate: "Hola {{contact_first_name}}",
      now: new Date("2025-06-02T09:00:00Z"),
      generateId: () => "id_x",
    });

    // Suppression is filtered out at candidate-selection time by the ChannelRouter itself
    // (belt-and-suspenders with the ComplianceGate check later in the pipeline), so no
    // eligible endpoint remains to route to.
    expect(result.results[0]?.outcome).toBe("skipped");
    expect(result.results[0]?.reason).toBe("no_eligible_endpoint");
  });

  it("a reply pauses the sequence: no further scheduled step is recommended after a reply event", () => {
    const steps: SequenceStepDefinition[] = [
      { stepIndex: 0, kind: "cold", delayAfterPreviousMs: 0 },
      { stepIndex: 1, kind: "warm_followup", delayAfterPreviousMs: 3 * 24 * 60 * 60 * 1000 },
    ];
    let events: OutreachEvent[] = [];
    const sentResult = ingestOutreachEvent(events, {
      outreachQueueItemId: "q_1",
      state: "sent",
      providerEventId: "evt_sent_1",
      payloadHash: null,
      occurredAt: "2025-06-01T09:00:00Z",
    }, () => "ev_1");
    events = sentResult.events;

    const repliedResult = ingestOutreachEvent(events, {
      outreachQueueItemId: "q_1",
      state: "replied",
      providerEventId: "evt_reply_1",
      payloadHash: null,
      occurredAt: "2025-06-01T12:00:00Z",
    }, () => "ev_2");
    events = repliedResult.events;

    const decision = decideNextSequenceAction({ steps, events, now: new Date("2025-06-10T09:00:00Z") });
    expect(decision.action).toBe("pause");
    expect(decision.reason).toBe("account_replied");
  });

  it("replaying the same bounce webhook event twice does not create a duplicate suppression-triggering event", () => {
    let events: OutreachEvent[] = [];
    const first = ingestOutreachEvent(events, {
      outreachQueueItemId: "q_1",
      state: "bounced",
      providerEventId: "evt_bounce_1",
      payloadHash: null,
      occurredAt: "2025-06-01T09:00:00Z",
    }, () => "ev_1");
    events = first.events;

    const second = ingestOutreachEvent(events, {
      outreachQueueItemId: "q_1",
      state: "bounced",
      providerEventId: "evt_bounce_1",
      payloadHash: null,
      occurredAt: "2025-06-01T09:00:00Z",
    }, () => "ev_2");

    expect(second.outcome).toBe("duplicate_skipped");
    expect(second.events).toHaveLength(1);
  });
});
