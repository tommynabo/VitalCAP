import { randomUUID } from "node:crypto";
import { listActiveCampaigns } from "@/infrastructure/neon/repositories/campaigns";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getPrimaryOffer } from "@/infrastructure/neon/repositories/offers";
import {
  getSentTodayByChannel,
  insertOutreachEvent,
  insertOutreachQueueItem,
  listMailboxes,
  listOutreachCandidatesForCampaign,
  listOutreachQueueItems,
  listSendingDomains,
  listSuppressionEntries,
} from "@/infrastructure/neon/repositories/outreach";
import { runOutreachDryRunCycle } from "@/services/outreach/outreach-orchestrator";

/**
 * No per-campaign/per-offer message template editor exists yet in this
 * codebase (`Campaign`/`Offer` have no `messageTemplate` field) — this
 * reuses the same canonical placeholder-only template already established
 * as the project's example/test default (see `message-renderer.test.ts`,
 * `simulate-outreach-day.test.ts`). Documented as a known limitation: real
 * per-offer copy authoring is a separate, not-yet-built feature.
 */
const DEFAULT_MESSAGE_TEMPLATE = "Hola {{contact_first_name}}, soy de {{offer_company}}. {{offer_primary_cta}}: {{offer_booking_url}}";

const MAX_CANDIDATES_PER_CAMPAIGN = 50;

export interface OutreachDryRunResult {
  campaignsProcessed: number;
  scheduled: number;
  skipped: number;
}

/**
 * One bounded dry-run outreach batch per active campaign in every
 * workspace. Per the standing "no live outreach" instruction and per
 * `runOutreachDryRunCycle`'s own hardcoded `deliveryMode: "dry_run"`, this
 * NEVER calls a real email/SMS delivery provider — it only plans and
 * persists `outreach_queue`/`outreach_events` rows. `smsRemainingCapacity`
 * is hardcoded to `0` (SMS is disabled entirely, no live SMS provider is
 * ever consulted). Called once per `/api/cron/outreach-dry-run` invocation.
 */
export async function runOutreachDryRunCronTick(now: Date = new Date()): Promise<OutreachDryRunResult> {
  const workspaceIds = await listWorkspaceIds();
  let campaignsProcessed = 0;
  let scheduled = 0;
  let skipped = 0;

  for (const workspaceId of workspaceIds) {
    const campaigns = await listActiveCampaigns(workspaceId);
    if (campaigns.length === 0) continue;

    const offer = await getPrimaryOffer(workspaceId);
    if (!offer) continue; // no offer configured yet for this workspace — nothing safe/approved to send

    const suppressionEntries = await listSuppressionEntries(workspaceId);
    const mailboxes = await listMailboxes(workspaceId);
    const sendingDomains = await listSendingDomains(workspaceId);
    const existingQueueItems = await listOutreachQueueItems(workspaceId);

    for (const campaign of campaigns) {
      const candidates = await listOutreachCandidatesForCampaign(campaign.id, MAX_CANDIDATES_PER_CAMPAIGN);
      campaignsProcessed += 1;
      if (candidates.length === 0) continue;

      const sentTodayByChannel = await getSentTodayByChannel(campaign.id);

      const cycle = await runOutreachDryRunCycle({
        candidates,
        existingQueueItems,
        suppressionEntries,
        desiredMix: campaign.desiredChannelMix,
        sentTodayByChannel,
        mailboxes,
        sendingDomains,
        smsRemainingCapacity: 0,
        offer,
        messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
        now,
        generateId: randomUUID,
      });

      for (const item of cycle.newQueueItems) await insertOutreachQueueItem(item);
      for (const event of cycle.newEvents) await insertOutreachEvent(event);

      for (const result of cycle.results) {
        if (result.outcome === "scheduled") scheduled += 1;
        else skipped += 1;
      }
    }
  }

  return { campaignsProcessed, scheduled, skipped };
}
