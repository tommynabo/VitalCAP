import { randomUUID } from "node:crypto";
import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import {
  insertDryRunWarmFollowupMessage,
  insertWarmFollowupQueueItem,
  listActiveWarmFollowupsForTriggerCheck,
  listDueWarmFollowups,
  listWarmFollowupEntryCandidates,
  updateWarmFollowupQueueItem,
} from "@/infrastructure/neon/repositories/warm-followup";
import { applyWarmFollowupTrigger, enterWarmFollowupQueue, recordFollowupDispatch } from "@/services/setter/warm-followup-service";

const MAX_PER_WORKSPACE = 200;

/**
 * No message-copy source exists yet for warm follow-ups (no LLM draft, no
 * per-offer template) — this is a minimal, static, dry-run-only placeholder
 * body. Real copy authoring is a separate, not-yet-built feature; this
 * cron never sends anything to a live provider regardless (metadata always
 * marks `deliveryMode: "dry_run"`, enforced inside the repository layer).
 */
const WARM_FOLLOWUP_DRY_RUN_BODY = "[dry_run] Warm follow-up check-in.";

export interface WarmFollowupRunnerResult {
  entered: number;
  paused: number;
  completed: number;
  dispatched: number;
}

/**
 * Three-phase warm-followup cron (Prompt 4 §4.12), run once per workspace:
 * (1) entry — newly warm-eligible conversations join the queue; (2) trigger
 * check — active items get paused ("reply") or completed ("meeting") when
 * the two schema-derivable triggers fire ("unsubscribe"/"human_ownership"
 * require an operator UI action that doesn't exist yet — documented gap,
 * not invented here); (3) dispatch — due items get one dry-run outgoing
 * message and are re-armed for the next cycle. Called once per
 * `/api/cron/warm-followup` invocation.
 */
export async function runWarmFollowupCronTick(now: Date = new Date()): Promise<WarmFollowupRunnerResult> {
  const workspaceIds = await listWorkspaceIds();
  let entered = 0;
  let paused = 0;
  let completed = 0;
  let dispatched = 0;

  for (const workspaceId of workspaceIds) {
    const entryCandidates = await listWarmFollowupEntryCandidates(workspaceId, MAX_PER_WORKSPACE);
    for (const candidate of entryCandidates) {
      const item = enterWarmFollowupQueue(candidate.conversationId, candidate.branch, false, now.toISOString(), randomUUID);
      if (!item) continue;
      await insertWarmFollowupQueueItem(item);
      entered += 1;
    }

    const triggerRows = await listActiveWarmFollowupsForTriggerCheck(workspaceId, MAX_PER_WORKSPACE);
    for (const row of triggerRows) {
      if (row.hasMeetingBooked) {
        await updateWarmFollowupQueueItem(applyWarmFollowupTrigger(row.item, "meeting"));
        completed += 1;
      } else if (row.hasReplySinceEntered) {
        await updateWarmFollowupQueueItem(applyWarmFollowupTrigger(row.item, "reply"));
        paused += 1;
      }
    }

    const due = await listDueWarmFollowups(workspaceId, now, MAX_PER_WORKSPACE);
    for (const { item, channel } of due) {
      await insertDryRunWarmFollowupMessage(item.conversationId, channel, WARM_FOLLOWUP_DRY_RUN_BODY);
      await updateWarmFollowupQueueItem(recordFollowupDispatch(item, now));
      dispatched += 1;
    }
  }

  return { entered, paused, completed, dispatched };
}
