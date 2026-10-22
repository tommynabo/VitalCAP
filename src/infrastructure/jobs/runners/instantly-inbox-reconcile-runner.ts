import { createHash } from "node:crypto";
import type { InboundEmailReply } from "@/domain/providers/types";
import { InstantlyInboxProvider, type InstantlyInboxPage } from "@/infrastructure/providers/instantly/inbox-provider";
import {
  getInstantlyInboxCheckpoint,
  listConfiguredInstantlyCampaigns,
  listSetterReplyReadbackCandidates,
  saveInstantlyInboxCheckpoint,
  type ConfiguredInstantlyCampaign,
  type InstantlyInboxCheckpoint,
  type SetterReplyReadbackCandidate,
} from "@/infrastructure/neon/repositories/instantly-inbox-reconciliation";
import { confirmSetterReplySent, neonSetterInboundRuntimeStore } from "@/infrastructure/neon/repositories/setter-runtime";
import { getDeliveryEnv } from "@/lib/config/env";
import { processInstantlyInboundReply, type SetterInboundRuntimeResult } from "@/services/setter/inbound-runtime";

export const MAX_INSTANTLY_INBOX_MESSAGES_PER_RUN = 100;
const MAX_OUTBOUND_READBACKS_PER_RUN = 10;
const CHECKPOINT_OVERLAP_MS = 60 * 60_000;
const OUTBOUND_READBACK_BEFORE_ATTEMPT_MS = 5 * 60_000;
const OUTBOUND_READBACK_AFTER_ATTEMPT_MS = 24 * 60 * 60_000;
const DEFAULT_INITIAL_LOOKBACK_HOURS = 72;

export interface InstantlyInboxReconcileCounts {
  repliesFound: number;
  alreadyKnown: number;
  newRepliesImported: number;
  invalidOrUnmappable: number;
  unknownCampaign: number;
  contactMappingFailures: number;
  humanRequired: number;
  processingFailures: number;
  outboundConfirmed: number;
  outboundPending: number;
  outboundReadbackFailures: number;
}

export interface InstantlyInboxReconcileDependencies {
  listCampaigns(workspaceId?: string): Promise<ConfiguredInstantlyCampaign[]>;
  getCheckpoint(providerCampaignId: string): Promise<InstantlyInboxCheckpoint | null>;
  saveCheckpoint(providerCampaignId: string, checkpoint: InstantlyInboxCheckpoint): Promise<void>;
  listPendingReplies(input: { workspaceId?: string; limit: number; staleSendingBefore: Date }): Promise<SetterReplyReadbackCandidate[]>;
  listReceivedEmails(input: {
    campaignId: string;
    minTimestampCreated: string;
    limit: number;
    startingAfter: string | null;
  }): Promise<InstantlyInboxPage>;
  listSentEmails(input: {
    campaignId: string;
    minTimestampCreated: string;
    limit: number;
    startingAfter: string | null;
    eaccount?: string | null;
    search?: string | null;
  }): Promise<InstantlyInboxPage>;
  getEmail(emailId: string): Promise<Record<string, unknown>>;
  confirmSent(input: {
    workspaceId: string;
    campaignId: string;
    email: string;
    providerMessageId: string;
    occurredAt: string;
  }): Promise<"confirmed" | "already_confirmed" | "not_found" | "ambiguous">;
  ingest(event: InboundEmailReply, payloadHash: string): Promise<SetterInboundRuntimeResult>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeReceivedEmail(raw: Record<string, unknown>, expectedCampaignId: string): InboundEmailReply | null {
  const body = record(raw.body);
  const lead = record(raw.lead);
  const email = firstString(raw.lead, raw.lead_email, lead?.email)?.toLowerCase() ?? null;
  const providerMessageId = firstString(raw.id);
  const campaignId = firstString(raw.campaign_id) ?? expectedCampaignId;
  const occurredAtValue = firstString(raw.timestamp_email, raw.timestamp_created);
  const occurredAt = occurredAtValue ? new Date(occurredAtValue) : null;
  const bodyText = firstString(body?.text);
  if (raw.ue_type !== 2 || !providerMessageId || !campaignId || campaignId !== expectedCampaignId || !email || !bodyText || !occurredAt || Number.isNaN(occurredAt.getTime())) {
    return null;
  }

  return {
    eventType: "reply_received",
    providerEventId: providerMessageId,
    providerMessageId,
    providerThreadId: firstString(raw.thread_id) ?? `${campaignId}:${email}`,
    providerCampaignId: campaignId,
    email,
    subject: firstString(raw.subject) ?? "",
    body: bodyText,
    occurredAt: occurredAt.toISOString(),
    replyToUuid: providerMessageId,
    emailAccount: firstString(raw.eaccount, raw.email_account),
    workspace: firstString(raw.organization_id),
    campaignName: firstString(raw.campaign_name),
  };
}

function hashProviderRecord(email: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(email)).digest("hex");
}

function isContactMappingFailure(code: string | undefined): boolean {
  return code === "CONTACT_NOT_FOUND" || code === "AMBIGUOUS_CONTACT_MATCH";
}

function isProviderSentEmail(email: Record<string, unknown>): boolean {
  return email.ue_type === 3 || email.email_type === "sent";
}

function providerLeadEmail(email: Record<string, unknown>): string | null {
  return firstString(record(email.lead)?.email, email.lead, email.lead_email)?.toLowerCase() ?? null;
}

function matchesUnknownReply(candidate: SetterReplyReadbackCandidate, email: Record<string, unknown>): boolean {
  const body = record(email.body);
  const leadEmail = providerLeadEmail(email);
  const eaccount = firstString(email.eaccount, email.email_account);
  const threadId = firstString(email.thread_id);
  const createdAt = firstString(email.timestamp_created, email.timestamp_email);
  const parsedCreatedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  const attemptedAt = Date.parse(candidate.attemptedAt);
  return isProviderSentEmail(email)
    && firstString(email.campaign_id) === candidate.providerCampaignId
    && leadEmail === candidate.email.toLowerCase()
    && candidate.emailAccount !== null
    && eaccount === candidate.emailAccount
    && candidate.providerThreadId !== null
    && threadId === candidate.providerThreadId
    && firstString(body?.text) === candidate.finalText
    && Number.isFinite(parsedCreatedAt)
    && Number.isFinite(attemptedAt)
    && parsedCreatedAt >= attemptedAt - OUTBOUND_READBACK_BEFORE_ATTEMPT_MS
    && parsedCreatedAt <= attemptedAt + OUTBOUND_READBACK_AFTER_ATTEMPT_MS;
}

function createProviderDependencies(provider: InstantlyInboxProvider): InstantlyInboxReconcileDependencies {
  return {
    listCampaigns: listConfiguredInstantlyCampaigns,
    getCheckpoint: getInstantlyInboxCheckpoint,
    saveCheckpoint: saveInstantlyInboxCheckpoint,
    listPendingReplies: listSetterReplyReadbackCandidates,
    listReceivedEmails: (input) => provider.listReceivedEmails(input),
    listSentEmails: (input) => provider.listSentEmails(input),
    getEmail: (emailId) => provider.getEmail(emailId),
    confirmSent: (input) => confirmSetterReplySent({ ...input, confirmationSource: "readback" }),
    ingest: (event, payloadHash) => processInstantlyInboundReply(event, payloadHash, neonSetterInboundRuntimeStore),
  };
}

async function reconcileOutboundReplies(
  dependencies: InstantlyInboxReconcileDependencies,
  campaigns: ConfiguredInstantlyCampaign[],
  options: { workspaceId?: string; now: Date },
  counts: InstantlyInboxReconcileCounts,
): Promise<void> {
  const candidates = await dependencies.listPendingReplies({
    workspaceId: options.workspaceId,
    limit: MAX_OUTBOUND_READBACKS_PER_RUN,
    staleSendingBefore: new Date(options.now.getTime() - 5 * 60_000),
  });
  const configuredCampaignIds = new Set(campaigns.map((campaign) => campaign.providerCampaignId));

  for (const candidate of candidates) {
    if (!configuredCampaignIds.has(candidate.providerCampaignId)) continue;
    try {
      let sentEmail: Record<string, unknown> | null = null;
      if (candidate.providerMessageId) {
        const detail = await dependencies.getEmail(candidate.providerMessageId);
        if (firstString(detail.id) === candidate.providerMessageId
          && isProviderSentEmail(detail)
          && firstString(detail.campaign_id) === candidate.providerCampaignId
          && providerLeadEmail(detail) === candidate.email.toLowerCase()) {
          sentEmail = detail;
        }
      } else {
        if (!candidate.emailAccount || !candidate.providerThreadId) {
          counts.outboundPending++;
          continue;
        }
        const page = await dependencies.listSentEmails({
          campaignId: candidate.providerCampaignId,
          minTimestampCreated: new Date(Date.parse(candidate.attemptedAt) - CHECKPOINT_OVERLAP_MS).toISOString(),
          limit: 100,
          startingAfter: null,
          eaccount: candidate.emailAccount,
          search: `thread:${candidate.providerThreadId}`,
        });
        sentEmail = page.items.find((item) => matchesUnknownReply(candidate, item)) ?? null;
      }

      if (!sentEmail) {
        counts.outboundPending++;
        continue;
      }
      const providerMessageId = firstString(sentEmail.id);
      if (!providerMessageId) {
        counts.outboundPending++;
        continue;
      }
      const occurredAt = firstString(sentEmail.timestamp_email, sentEmail.timestamp_created) ?? options.now.toISOString();
      const confirmation = await dependencies.confirmSent({
        workspaceId: candidate.workspaceId,
        campaignId: candidate.campaignId,
        email: candidate.email,
        providerMessageId,
        occurredAt,
      });
      if (confirmation === "confirmed" || confirmation === "already_confirmed") counts.outboundConfirmed++;
      else counts.outboundReadbackFailures++;
    } catch {
      counts.outboundReadbackFailures++;
    }
  }
}

export async function runInstantlyInboxReconcile(
  dependencies: InstantlyInboxReconcileDependencies,
  options: {
    workspaceId?: string;
    now?: Date;
    initialLookbackHours?: number;
    maxMessagesPerRun?: number;
  } = {},
): Promise<InstantlyInboxReconcileCounts> {
  const now = options.now ?? new Date();
  const maxMessages = Math.min(MAX_INSTANTLY_INBOX_MESSAGES_PER_RUN, Math.max(1, options.maxMessagesPerRun ?? MAX_INSTANTLY_INBOX_MESSAGES_PER_RUN));
  const lookbackHours = Math.min(168, Math.max(1, options.initialLookbackHours ?? DEFAULT_INITIAL_LOOKBACK_HOURS));
  const counts: InstantlyInboxReconcileCounts = {
    repliesFound: 0,
    alreadyKnown: 0,
    newRepliesImported: 0,
    invalidOrUnmappable: 0,
    unknownCampaign: 0,
    contactMappingFailures: 0,
    humanRequired: 0,
    processingFailures: 0,
    outboundConfirmed: 0,
    outboundPending: 0,
    outboundReadbackFailures: 0,
  };
  const campaigns = await dependencies.listCampaigns(options.workspaceId);

  for (const campaign of campaigns) {
    if (counts.repliesFound >= maxMessages) break;
    const checkpoint = await dependencies.getCheckpoint(campaign.providerCampaignId);
    const overrideWindow = options.initialLookbackHours !== undefined;
    const windowStartedAt = overrideWindow
      ? new Date(now.getTime() - lookbackHours * 60 * 60_000)
      : checkpoint?.windowStartedAt
        ? new Date(checkpoint.windowStartedAt)
        : new Date((checkpoint?.checkpointAt ? Date.parse(checkpoint.checkpointAt) : now.getTime()) - (checkpoint?.checkpointAt ? CHECKPOINT_OVERLAP_MS : lookbackHours * 60 * 60_000));
    let startingAfter = overrideWindow ? null : checkpoint?.nextStartingAfter ?? null;
    let campaignFailed = false;
    let finishedWindow = false;

    while (!finishedWindow && counts.repliesFound < maxMessages) {
      const remaining = maxMessages - counts.repliesFound;
      const page = await dependencies.listReceivedEmails({
        campaignId: campaign.providerCampaignId,
        minTimestampCreated: windowStartedAt.toISOString(),
        limit: Math.min(100, remaining),
        startingAfter,
      });
      if (page.items.length === 0 && page.nextStartingAfter && page.nextStartingAfter === startingAfter) {
        counts.processingFailures++;
        campaignFailed = true;
        break;
      }

      for (const listedEmail of page.items) {
        counts.repliesFound++;
        let providerEmail = listedEmail;
        const listedBody = record(providerEmail.body);
        if (providerEmail.body_fallback_reason || !firstString(listedBody?.text)) {
          const providerId = firstString(providerEmail.id);
          if (providerId) providerEmail = { ...providerEmail, ...await dependencies.getEmail(providerId) };
        }
        const event = normalizeReceivedEmail(providerEmail, campaign.providerCampaignId);
        if (!event) {
          counts.invalidOrUnmappable++;
          continue;
        }

        try {
          const outcome = await dependencies.ingest(event, hashProviderRecord(providerEmail));
          if (outcome.outcome === "duplicate_skipped") counts.alreadyKnown++;
          else if (outcome.outcome === "ignored_unknown_campaign") counts.unknownCampaign++;
          else if (outcome.outcome === "human_required") {
            if (isContactMappingFailure(outcome.failureCode)) {
              counts.contactMappingFailures++;
              counts.invalidOrUnmappable++;
            } else if (outcome.failureCode === "AMBIGUOUS_CAMPAIGN" || outcome.failureCode === "UNKNOWN_CAMPAIGN") {
              counts.unknownCampaign++;
              counts.invalidOrUnmappable++;
            } else {
              counts.newRepliesImported++;
              counts.humanRequired++;
            }
          } else counts.newRepliesImported++;
        } catch {
          counts.processingFailures++;
          campaignFailed = true;
          break;
        }
      }
      if (campaignFailed) break;

      if (page.nextStartingAfter && page.nextStartingAfter === startingAfter) {
        counts.processingFailures++;
        campaignFailed = true;
        break;
      }
      startingAfter = page.nextStartingAfter;
      if (!startingAfter) {
        finishedWindow = true;
        await dependencies.saveCheckpoint(campaign.providerCampaignId, {
          checkpointAt: now.toISOString(),
          windowStartedAt: null,
          nextStartingAfter: null,
        });
      } else {
        await dependencies.saveCheckpoint(campaign.providerCampaignId, {
          checkpointAt: checkpoint?.checkpointAt ?? null,
          windowStartedAt: windowStartedAt.toISOString(),
          nextStartingAfter: startingAfter,
        });
      }
    }
  }

  await reconcileOutboundReplies(dependencies, campaigns, { workspaceId: options.workspaceId, now }, counts);
  return counts;
}

export async function runInstantlyInboxReconcileTick(options: {
  workspaceId?: string;
  initialLookbackHours?: number;
  maxMessagesPerRun?: number;
} = {}): Promise<InstantlyInboxReconcileCounts> {
  const env = getDeliveryEnv();
  if (env.EMAIL_DELIVERY_PROVIDER !== "instantly" || !env.INSTANTLY_API_KEY) {
    throw new Error("Instantly inbox reconciliation is not configured.");
  }
  return runInstantlyInboxReconcile(
    createProviderDependencies(new InstantlyInboxProvider(env.INSTANTLY_API_KEY)),
    options,
  );
}
