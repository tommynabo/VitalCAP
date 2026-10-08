/**
 * Single data-access facade for every dashboard/admin page (Prompt 7 Gate C).
 * Each exported function resolves the current workspace, then branches on
 * `isDevSeedMode()`: dev-seed mode returns the exact in-memory fixtures from
 * `src/lib/seed/dev-seed.ts` (unchanged), real mode queries Neon via the
 * repository layer under `src/infrastructure/neon/repositories/*`. Pages
 * must import from this module only — never from `dev-seed.ts` or the Neon
 * repositories directly — so dev-seed mode and production mode are provably
 * identical from the UI's point of view.
 */

import { getDeliveryEnv, isDevSeedMode } from "@/lib/config/env";
import { getCurrentWorkspaceId } from "@/lib/auth/workspace";

import * as seed from "@/lib/seed/dev-seed";

import { getPrimaryOffer, listOffers } from "@/infrastructure/neon/repositories/offers";
import { listSetterWebhookEvents, type SetterWebhookEventSummary } from "@/infrastructure/neon/repositories/setter-runtime";
import { listCampaigns, listSetterQueueCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listAccountBundles, listSetterQueueAccounts, type AccountBundle } from "@/infrastructure/neon/repositories/accounts";
import {
  countInfrastructureAlerts,
  listOutreachQueueItems,
  listOutreachEvents,
  listSendingDomains,
  listMailboxes,
  listSuppressionEntries,
} from "@/infrastructure/neon/repositories/outreach";
import {
  countPendingReviewConversations,
  getOldestPendingReviewAt,
  listLatestIncomingSetterQueueMessages,
  listPendingReviewConversations,
  listSetterQueueDrafts,
  listSetterQueueMessages,
  listConversations,
  listConversationMessages,
  listSetterDrafts,
  listSetterFeedback,
  listMeetings,
} from "@/infrastructure/neon/repositories/conversations";
import { listSearchSeeds } from "@/infrastructure/neon/repositories/discovery";
import {
  getAutopilotSettings,
  getGlobalAutopilotState,
  getEngineHealthSummary as getNeonEngineHealthSummary,
  listEngineTargets,
  listRebalanceDecisions,
} from "@/infrastructure/neon/repositories/autopilot";
import { summarizeEngineHealthStatuses } from "@/services/discovery/provider-health";
import { getAutopilotPacingMetrics } from "@/infrastructure/neon/repositories/autopilot-pacing";
import {
  getProviderRows,
  getEmailVerificationUsage,
  getEmailVerificationMetrics,
  type EmailVerificationMetrics,
  getQueueHealth,
  getDeadLetterSamples,
  getCronLastRunAt,
  getLastCronRouteRunAt,
  getWebhookLastEventAt,
  getDbConnectivityOk,
  type ProviderRowStatus,
  type QueueHealthSnapshot,
  type DeadLetterSample,
  getInstantlyPipelineDiagnostics,
  type InstantlyPipelineDiagnostics,
} from "@/infrastructure/neon/repositories/diagnostics";
import { getWeeklyTrend, type WeeklyTrendPoint } from "@/infrastructure/neon/repositories/analytics";

import type { Offer, Campaign } from "@/domain/campaigns/types";
import type { AutopilotSettings, GlobalAutopilotState, EngineTargetState, RebalanceDecision } from "@/domain/autopilot/types";
import type { EngineHealthSummary } from "@/services/discovery/provider-health";
import type {
  OutreachQueueItem,
  OutreachEvent,
  SendingDomain,
  Mailbox,
  SuppressionEntry,
} from "@/domain/outreach/types";
import type { Conversation, ConversationMessage, SetterDraft, SetterFeedback, Meeting } from "@/domain/conversations/types";
import type { SearchSeed } from "@/domain/discovery/types";
import type { ProviderUsageStats } from "@/domain/providers/types";
import {
  loadSetterReviewQueuePage,
  SETTER_REVIEW_QUEUE_LIMIT,
  type SetterQueueCursor,
  type SetterReviewQueuePage,
} from "@/services/setter/review-queue";

export type { AccountBundle, ProviderRowStatus, QueueHealthSnapshot, DeadLetterSample, WeeklyTrendPoint };
export type { InstantlyPipelineDiagnostics };

export async function getOffer(): Promise<Offer | null> {
  if (isDevSeedMode()) return seed.seedOffer;
  const workspaceId = await getCurrentWorkspaceId();
  return getPrimaryOffer(workspaceId);
}

export async function getOffers(): Promise<Offer[]> {
  if (isDevSeedMode()) return [seed.seedOffer];
  return listOffers(await getCurrentWorkspaceId());
}

export async function getSetterWebhookEvents(): Promise<SetterWebhookEventSummary[]> {
  if (isDevSeedMode()) return [];
  return listSetterWebhookEvents(await getCurrentWorkspaceId());
}

export async function getCampaigns(): Promise<Campaign[]> {
  if (isDevSeedMode()) return seed.seedCampaigns;
  const workspaceId = await getCurrentWorkspaceId();
  return listCampaigns(workspaceId);
}

export async function getAccountBundles(): Promise<AccountBundle[]> {
  if (isDevSeedMode()) return seed.seedAccountBundles;
  const workspaceId = await getCurrentWorkspaceId();
  return listAccountBundles(workspaceId);
}

function getSeedSetterReviewQueuePage(cursor: SetterQueueCursor | null): Promise<SetterReviewQueuePage> {
  return loadSetterReviewQueuePage({
    listPendingConversations: async (limit, pageCursor) => seed.seedConversations
      .filter((conversation) => conversation.state === "pending_review")
      .filter((conversation) => !pageCursor
        || conversation.updatedAt < pageCursor.updatedAt
        || (conversation.updatedAt === pageCursor.updatedAt && conversation.id < pageCursor.id))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map(({ id, accountId, contactId, campaignId, state, latestIntent, updatedAt }) => ({
        id, accountId, contactId, campaignId, state, latestIntent, updatedAt,
      })),
    listMessages: async (conversationIds) => {
      const ids = new Set(conversationIds);
      return seed.seedConversationMessages
        .filter((message) => ids.has(message.conversationId))
        .map(({ id, conversationId, direction, body, createdAt }) => ({ id, conversationId, direction, body, createdAt }));
    },
    listLatestInboundMessages: async (conversationIds) => {
      const ids = new Set(conversationIds);
      const latestByConversation = new Map();
      for (const message of seed.seedConversationMessages) {
        if (!ids.has(message.conversationId) || message.direction !== "incoming") continue;
        const previous = latestByConversation.get(message.conversationId);
        if (!previous || Date.parse(message.createdAt) > Date.parse(previous.createdAt)) {
          latestByConversation.set(message.conversationId, message);
        }
      }
      return [...latestByConversation.values()].map(({ id, conversationId, direction, body, createdAt }) => ({
        id, conversationId, direction, body, createdAt,
      }));
    },
    listDrafts: async (messageIds) => {
      const ids = new Set(messageIds);
      return seed.seedSetterDrafts
        .filter((draft) => ids.has(draft.conversationMessageId))
        .map(({ id, conversationMessageId, draft, confidence, riskFlags }) => ({ id, conversationMessageId, draft, confidence, riskFlags }));
    },
    listAccounts: async (accountIds, contactIds) => {
      const ids = new Set(accountIds);
      const visibleContactIds = new Set(contactIds);
      return seed.seedAccountBundles
        .filter((bundle) => ids.has(bundle.account.id))
        .map(({ account, contacts }) => ({
          account: { id: account.id, canonicalName: account.canonicalName },
          contacts: contacts
            .filter((contact) => visibleContactIds.has(contact.id))
            .map(({ id, firstName, fullName }) => ({ id, firstName, fullName })),
        }));
    },
    listCampaigns: async (campaignIds) => {
      const ids = new Set(campaignIds);
      return seed.seedCampaigns.filter((campaign) => ids.has(campaign.id)).map(({ id, name }) => ({ id, name }));
    },
    countPendingConversations: async () => seed.seedConversations.filter((conversation) => conversation.state === "pending_review").length,
    getOldestPendingAt: async () => {
      const pendingIds = new Set(seed.seedConversations
        .filter((conversation) => conversation.state === "pending_review")
        .map((conversation) => conversation.id));
      return seed.seedConversationMessages
        .filter((message) => pendingIds.has(message.conversationId) && message.direction === "incoming")
        .map((message) => message.createdAt)
        .sort()[0] ?? null;
    },
  }, cursor);
}

export async function getSetterReviewQueuePage(cursor: SetterQueueCursor | null = null): Promise<SetterReviewQueuePage> {
  return getSetterReviewQueuePageForWorkspace(await getCurrentWorkspaceId(), cursor);
}

export async function getSetterReviewQueuePageForWorkspace(
  workspaceId: string,
  cursor: SetterQueueCursor | null = null,
): Promise<SetterReviewQueuePage> {
  if (isDevSeedMode()) return getSeedSetterReviewQueuePage(cursor);
  return loadSetterReviewQueuePage({
    listPendingConversations: (limit, pageCursor) => listPendingReviewConversations(workspaceId, limit, pageCursor),
    listLatestInboundMessages: (conversationIds) => listLatestIncomingSetterQueueMessages(workspaceId, conversationIds),
    listMessages: (conversationIds) => listSetterQueueMessages(workspaceId, conversationIds),
    listDrafts: (messageIds) => listSetterQueueDrafts(workspaceId, messageIds),
    listAccounts: (accountIds, contactIds) => listSetterQueueAccounts(workspaceId, accountIds, contactIds),
    listCampaigns: (campaignIds) => listSetterQueueCampaigns(workspaceId, campaignIds),
    countPendingConversations: () => countPendingReviewConversations(workspaceId),
    getOldestPendingAt: () => getOldestPendingReviewAt(workspaceId),
  }, cursor, SETTER_REVIEW_QUEUE_LIMIT);
}

export async function getPendingReviewCountData(): Promise<number> {
  if (isDevSeedMode()) return seed.seedConversations.filter((conversation) => conversation.state === "pending_review").length;
  return countPendingReviewConversations(await getCurrentWorkspaceId());
}

export async function getInfrastructureAlertCountData(): Promise<number> {
  if (isDevSeedMode()) {
    return seed.seedSendingDomains.filter((domain) => domain.status === "degraded" || domain.status === "paused").length
      + seed.seedMailboxes.filter((mailbox) => mailbox.pausedReason).length;
  }
  return countInfrastructureAlerts(await getCurrentWorkspaceId());
}

export async function getGlobalAutopilotStateData(): Promise<GlobalAutopilotState> {
  if (isDevSeedMode()) return seed.getSeedGlobalAutopilotState();
  const workspaceId = await getCurrentWorkspaceId();
  return getGlobalAutopilotState(workspaceId);
}

export async function getAutopilotSettingsData(): Promise<AutopilotSettings> {
  if (isDevSeedMode()) {
    return {
      workspaceId: "ws_demo",
      enabled: false,
      emergencyStopped: false,
      systemPaused: false,
      systemPauseReason: null,
      systemPausedAt: null,
      globalDailyTarget: 25,
      targetMetric: "qualified",
      timezone: "Europe/Madrid",
      operatingStartHour: null,
      operatingEndHour: null,
      maxDailyApifySpendUsd: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }
  return getAutopilotSettings(await getCurrentWorkspaceId());
}

export async function getEngineTargets(): Promise<EngineTargetState[]> {
  if (isDevSeedMode()) return seed.seedEngineTargets;
  const workspaceId = await getCurrentWorkspaceId();
  return listEngineTargets(workspaceId);
}

export async function getEngineHealthSummary(): Promise<EngineHealthSummary> {
  if (isDevSeedMode()) return summarizeEngineHealthStatuses(seed.seedEngineTargets.map((target) => target.providerHealth));
  return getNeonEngineHealthSummary(await getCurrentWorkspaceId());
}

export async function getRebalanceDecisions(): Promise<RebalanceDecision[]> {
  if (isDevSeedMode()) return seed.seedRebalanceDecisions;
  const workspaceId = await getCurrentWorkspaceId();
  return listRebalanceDecisions(workspaceId);
}

export async function getSendingDomains(): Promise<SendingDomain[]> {
  if (isDevSeedMode()) return seed.seedSendingDomains;
  const workspaceId = await getCurrentWorkspaceId();
  return listSendingDomains(workspaceId);
}

export async function getMailboxes(): Promise<Mailbox[]> {
  if (isDevSeedMode()) return seed.seedMailboxes;
  const workspaceId = await getCurrentWorkspaceId();
  return listMailboxes(workspaceId);
}

export async function getSuppressionEntries(): Promise<SuppressionEntry[]> {
  if (isDevSeedMode()) return seed.seedSuppressionEntries;
  const workspaceId = await getCurrentWorkspaceId();
  return listSuppressionEntries(workspaceId);
}

export async function getOutreachQueueItems(): Promise<OutreachQueueItem[]> {
  if (isDevSeedMode()) return seed.seedOutreachQueueItems;
  const workspaceId = await getCurrentWorkspaceId();
  return listOutreachQueueItems(workspaceId);
}

export async function getOutreachEvents(): Promise<OutreachEvent[]> {
  if (isDevSeedMode()) return seed.seedOutreachEvents;
  const workspaceId = await getCurrentWorkspaceId();
  return listOutreachEvents(workspaceId);
}

export async function getConversations(): Promise<Conversation[]> {
  if (isDevSeedMode()) return seed.seedConversations;
  const workspaceId = await getCurrentWorkspaceId();
  return listConversations(workspaceId);
}

export async function getConversationMessages(): Promise<ConversationMessage[]> {
  if (isDevSeedMode()) return seed.seedConversationMessages;
  const workspaceId = await getCurrentWorkspaceId();
  return listConversationMessages(workspaceId);
}

export async function getSetterDrafts(): Promise<SetterDraft[]> {
  if (isDevSeedMode()) return seed.seedSetterDrafts;
  const workspaceId = await getCurrentWorkspaceId();
  return listSetterDrafts(workspaceId);
}

export async function getSetterFeedback(): Promise<SetterFeedback[]> {
  if (isDevSeedMode()) return seed.seedSetterFeedback;
  const workspaceId = await getCurrentWorkspaceId();
  return listSetterFeedback(workspaceId);
}

export async function getMeetings(): Promise<Meeting[]> {
  if (isDevSeedMode()) return seed.seedMeetings;
  const workspaceId = await getCurrentWorkspaceId();
  return listMeetings(workspaceId);
}

export async function getWeeklyTrendData(): Promise<WeeklyTrendPoint[]> {
  if (isDevSeedMode()) return seed.seedWeeklyTrend;
  const workspaceId = await getCurrentWorkspaceId();
  return getWeeklyTrend(workspaceId);
}

export async function getProviderRowsData(): Promise<Array<{ name: string; status: ProviderRowStatus; detail: string }>> {
  if (isDevSeedMode()) return seed.seedProviderRows;
  return getProviderRows();
}

export async function getEmailVerificationUsageData(): Promise<ProviderUsageStats> {
  if (isDevSeedMode()) return seed.seedEmailVerificationUsage;
  const workspaceId = await getCurrentWorkspaceId();
  return getEmailVerificationUsage(workspaceId);
}

export async function getInstantlyPipelineDiagnosticsData(): Promise<InstantlyPipelineDiagnostics | null> {
  if (isDevSeedMode()) return null;
  const workspaceId = await getCurrentWorkspaceId();
  return getInstantlyPipelineDiagnostics(workspaceId, getDeliveryEnv().INSTANTLY_CAMPAIGN_ID);
}

export async function getEmailVerificationMetricsData(): Promise<EmailVerificationMetrics> {
  if (isDevSeedMode()) {
    const contactPoints = seed.seedAccountBundles.flatMap((bundle) => bundle.contactPoints).filter((point) => point.type === "email");
    const count = (statuses: readonly string[]) => contactPoints.filter((point) => statuses.includes(point.verificationStatus)).length;
    return {
      unverified: count(["unverified", "unknown"]),
      valid: count(["valid"]),
      catchAll: count(["catch_all"]),
      risky: count(["risky"]),
      invalid: count(["invalid", "disposable", "bounced"]),
      blocked: contactPoints.filter((point) => ["invalid", "disposable", "bounced"].includes(point.verificationStatus) || ["opted_out", "blocked"].includes(point.channelEligibility)).length,
      ready: seed.seedAccountBundles.filter((bundle) => bundle.account.status === "outreach_ready").length,
    };
  }
  return getEmailVerificationMetrics(await getCurrentWorkspaceId());
}

export async function getSearchSeeds(): Promise<SearchSeed[]> {
  if (isDevSeedMode()) return seed.seedSearchSeeds;
  const workspaceId = await getCurrentWorkspaceId();
  return listSearchSeeds(workspaceId);
}

export async function getQueueHealthData(): Promise<QueueHealthSnapshot> {
  if (isDevSeedMode()) return seed.seedQueueHealth;
  const workspaceId = await getCurrentWorkspaceId();
  return getQueueHealth(workspaceId);
}

export async function getCronLastRunAtData(): Promise<string | null> {
  if (isDevSeedMode()) return seed.seedCronLastRunAt;
  const workspaceId = await getCurrentWorkspaceId();
  return getCronLastRunAt(workspaceId);
}

export async function getLastCronRouteRunAtData(route: "autopilot" | "discovery"): Promise<string | null> {
  if (isDevSeedMode()) return seed.seedCronLastRunAt;
  return getLastCronRouteRunAt(route);
}

export async function getWebhookLastEventAtData(): Promise<string | null> {
  if (isDevSeedMode()) return seed.seedWebhookLastEventAt;
  const workspaceId = await getCurrentWorkspaceId();
  return getWebhookLastEventAt(workspaceId);
}

export async function getDbConnectivityOkData(): Promise<boolean> {
  if (isDevSeedMode()) return seed.seedDbConnectivityOk;
  return getDbConnectivityOk();
}

export async function getDeadLetterSamplesData(): Promise<DeadLetterSample[]> {
  if (isDevSeedMode()) return seed.seedDeadLetterSamples;
  const workspaceId = await getCurrentWorkspaceId();
  return getDeadLetterSamples(workspaceId);
}

export async function getAutopilotPacingMetricsData(now = new Date()) {
  if (isDevSeedMode()) {
    return {
      qualifiedToday: 0,
      rawRequestedToday: 0,
      rawReturnedToday: 0,
      processingInFlight: 0,
      providerRunsInFlight: 0,
      providerRawItemsInFlight: 0,
      apifySpendToday: 0,
      historicalRawSampleSize: 0,
      historicalQualifiedCount: 0,
    };
  }
  const workspaceId = await getCurrentWorkspaceId();
  const settings = await getAutopilotSettings(workspaceId);
  return getAutopilotPacingMetrics(workspaceId, settings.timezone, now);
}
