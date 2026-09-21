import type { ContactPoint } from "@/domain/contacts/types";
import type { DesiredChannelMix, Offer } from "@/domain/campaigns/types";
import type { Mailbox, OutreachEvent, OutreachQueueItem, SendingDomain, SuppressionEntry } from "@/domain/outreach/types";
import { routeAccountToEndpoint } from "./channel-router";
import { selectMailboxForSend, summarizeSenderPoolCapacity } from "./sender-pool-service";
import { mixChannelForContactPointType, planChannelMix, type ChannelMixPlan, type MixChannel } from "./channel-mix-planner";
import { SuppressionAwareComplianceGate } from "@/services/compliance/compliance-gate";
import { renderMessageTemplate } from "./message-renderer";

/**
 * Dry-run outreach orchestrator (Prompt 3 §3.12). Composes the router,
 * sender pool, mix planner, compliance gate and renderer into one pass over
 * a batch of candidate accounts. Per Prompt 1's `deliveryMode` contract,
 * this orchestrator ONLY ever runs in `dry_run` mode — it records a planned
 * `OutreachQueueItem`/`OutreachEvent` pair and never imports or calls an
 * `EmailDeliveryProvider`/`SmsDeliveryProvider`. Flipping to live sending is
 * a separate, explicit operator action outside this function's scope.
 */

export interface OutreachCandidate {
  accountId: string;
  campaignId: string;
  contactPoints: readonly ContactPoint[];
  contactFirstName: string | null;
  accountName: string;
}

export interface OutreachCycleInput {
  candidates: readonly OutreachCandidate[];
  existingQueueItems: readonly OutreachQueueItem[];
  suppressionEntries: readonly SuppressionEntry[];
  desiredMix: DesiredChannelMix;
  sentTodayByChannel: Record<MixChannel, number>;
  mailboxes: readonly Mailbox[];
  sendingDomains: readonly SendingDomain[];
  /** No SMS sender-pool domain model exists yet this phase; remaining SMS capacity is supplied directly. */
  smsRemainingCapacity: number;
  offer: Offer;
  messageTemplate: string;
  now: Date;
  generateId: () => string;
}

export type OutreachCycleOutcome = "scheduled" | "skipped";

export interface OutreachCycleItemResult {
  accountId: string;
  outcome: OutreachCycleOutcome;
  reason: string | null;
  queueItem: OutreachQueueItem | null;
  renderedBody: string | null;
}

export interface OutreachCycleResult {
  results: OutreachCycleItemResult[];
  newQueueItems: OutreachQueueItem[];
  newEvents: OutreachEvent[];
  mixPlan: ChannelMixPlan;
}

export async function runOutreachDryRunCycle(input: OutreachCycleInput): Promise<OutreachCycleResult> {
  const emailCapacity = summarizeSenderPoolCapacity({ mailboxes: input.mailboxes, sendingDomains: input.sendingDomains });
  const mixPlan = planChannelMix({
    desiredMix: input.desiredMix,
    sentTodayByChannel: input.sentTodayByChannel,
    remainingCapacityByChannel: { email: emailCapacity.totalRemainingCapacity, sms: input.smsRemainingCapacity },
  });

  const remainingAllocatable: Record<MixChannel, number> = {
    email: mixPlan.allocations.find((a) => a.channel === "email")!.allocatable,
    sms: mixPlan.allocations.find((a) => a.channel === "sms")!.allocatable,
  };

  let workingMailboxes = [...input.mailboxes];
  const gate = new SuppressionAwareComplianceGate(() => input.suppressionEntries);

  const results: OutreachCycleItemResult[] = [];
  const newQueueItems: OutreachQueueItem[] = [];
  const newEvents: OutreachEvent[] = [];

  for (const candidate of input.candidates) {
    const route = routeAccountToEndpoint({
      accountId: candidate.accountId,
      contactPoints: candidate.contactPoints,
      existingQueueItems: [...input.existingQueueItems, ...newQueueItems],
      suppressionEntries: input.suppressionEntries,
      now: input.now,
    });

    if (route.blockedReason || !route.selectedContactPointId || !route.channel) {
      results.push({ accountId: candidate.accountId, outcome: "skipped", reason: route.blockedReason ?? "no_eligible_endpoint", queueItem: null, renderedBody: null });
      continue;
    }

    const mixChannel = mixChannelForContactPointType(route.channel);
    if (!mixChannel) {
      results.push({ accountId: candidate.accountId, outcome: "skipped", reason: "channel_not_supported", queueItem: null, renderedBody: null });
      continue;
    }

    if (remainingAllocatable[mixChannel] <= 0) {
      results.push({ accountId: candidate.accountId, outcome: "skipped", reason: "mix_budget_exhausted", queueItem: null, renderedBody: null });
      continue;
    }

    if (mixChannel === "email") {
      const mailbox = selectMailboxForSend({ mailboxes: workingMailboxes, sendingDomains: input.sendingDomains });
      if (!mailbox) {
        results.push({ accountId: candidate.accountId, outcome: "skipped", reason: "no_sender_capacity", queueItem: null, renderedBody: null });
        continue;
      }
      workingMailboxes = workingMailboxes.map((m) => (m.id === mailbox.id ? { ...m, sentToday: m.sentToday + 1 } : m));
    }

    const selectedContactPoint = candidate.contactPoints.find((cp) => cp.id === route.selectedContactPointId)!;

    const complianceResult = await gate.check({
      contactPointId: selectedContactPoint.id,
      accountId: candidate.accountId,
      campaignId: candidate.campaignId,
      channel: route.channel,
      currentEligibility: selectedContactPoint.channelEligibility,
    });

    if (!complianceResult.allowed) {
      results.push({ accountId: candidate.accountId, outcome: "skipped", reason: complianceResult.reason, queueItem: null, renderedBody: null });
      continue;
    }

    const rendered = renderMessageTemplate(input.messageTemplate, {
      contactFirstName: candidate.contactFirstName,
      accountName: candidate.accountName,
      offer: input.offer,
    });

    const queueItem: OutreachQueueItem = {
      id: input.generateId(),
      campaignId: candidate.campaignId,
      accountId: candidate.accountId,
      contactId: selectedContactPoint.contactId,
      contactPointId: selectedContactPoint.id,
      channel: route.channel,
      priority: selectedContactPoint.priorityScore,
      scheduledFor: input.now.toISOString(),
      state: "scheduled",
      deliveryMode: "dry_run",
    };
    const event: OutreachEvent = {
      id: input.generateId(),
      outreachQueueItemId: queueItem.id,
      state: "scheduled",
      providerEventId: null,
      payloadHash: null,
      occurredAt: input.now.toISOString(),
    };

    newQueueItems.push(queueItem);
    newEvents.push(event);
    remainingAllocatable[mixChannel] -= 1;

    results.push({ accountId: candidate.accountId, outcome: "scheduled", reason: null, queueItem, renderedBody: rendered.body });
  }

  return { results, newQueueItems, newEvents, mixPlan };
}
