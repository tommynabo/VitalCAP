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

import { isDevSeedMode } from "@/lib/config/env";
import { getCurrentWorkspaceId } from "@/lib/auth/workspace";

import * as seed from "@/lib/seed/dev-seed";

import { getPrimaryOffer } from "@/infrastructure/neon/repositories/offers";
import { listCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listAccountBundles, type AccountBundle } from "@/infrastructure/neon/repositories/accounts";
import {
  listOutreachQueueItems,
  listOutreachEvents,
  listSendingDomains,
  listMailboxes,
  listSuppressionEntries,
} from "@/infrastructure/neon/repositories/outreach";
import {
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
  listEngineTargets,
  listRebalanceDecisions,
} from "@/infrastructure/neon/repositories/autopilot";
import {
  getProviderRows,
  getEmailVerificationUsage,
  getQueueHealth,
  getDeadLetterSamples,
  getCronLastRunAt,
  getLastCronRouteRunAt,
  getWebhookLastEventAt,
  getDbConnectivityOk,
  type ProviderRowStatus,
  type QueueHealthSnapshot,
  type DeadLetterSample,
} from "@/infrastructure/neon/repositories/diagnostics";
import { getWeeklyTrend, type WeeklyTrendPoint } from "@/infrastructure/neon/repositories/analytics";

import type { Offer, Campaign } from "@/domain/campaigns/types";
import type { AutopilotSettings, GlobalAutopilotState, EngineTargetState, RebalanceDecision } from "@/domain/autopilot/types";
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

export type { AccountBundle, ProviderRowStatus, QueueHealthSnapshot, DeadLetterSample, WeeklyTrendPoint };

export async function getOffer(): Promise<Offer | null> {
  if (isDevSeedMode()) return seed.seedOffer;
  const workspaceId = await getCurrentWorkspaceId();
  return getPrimaryOffer(workspaceId);
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
      globalDailyTarget: 25,
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
