import type { Mailbox, SendingDomain } from "@/domain/outreach/types";

/**
 * Sender pool capacity + health management (Prompt 3 §3.4). Capacity is
 * always computed from `dailyCapacity - sentToday` — never a hardcoded
 * number — and a mailbox is only usable when both the mailbox itself and
 * its parent sending domain are healthy. This is the single place that
 * decides "can we send one more message from this mailbox right now?", so
 * every other service (mix planner, orchestrator) must go through it rather
 * than re-deriving capacity math.
 */

export interface SenderPoolHealthPolicy {
  maxBounceRate: number;
  minHealthScore: number;
}

export const DEFAULT_SENDER_POOL_HEALTH_POLICY: SenderPoolHealthPolicy = {
  maxBounceRate: 0.05,
  minHealthScore: 50,
};

export function mailboxRemainingCapacity(mailbox: Mailbox): number {
  return Math.max(0, mailbox.dailyCapacity - mailbox.sentToday);
}

const USABLE_DOMAIN_STATUSES: ReadonlySet<SendingDomain["status"]> = new Set(["connected", "degraded"]);

export function isMailboxUsable(
  mailbox: Mailbox,
  sendingDomain: SendingDomain | undefined,
  policy: SenderPoolHealthPolicy = DEFAULT_SENDER_POOL_HEALTH_POLICY,
): boolean {
  if (mailbox.pausedReason !== null) return false;
  if (!sendingDomain || !USABLE_DOMAIN_STATUSES.has(sendingDomain.status)) return false;
  if (mailbox.bounceRate > policy.maxBounceRate) return false;
  if (mailbox.healthScore < policy.minHealthScore) return false;
  if (mailboxRemainingCapacity(mailbox) <= 0) return false;
  return true;
}

export interface SenderPoolInput {
  mailboxes: readonly Mailbox[];
  sendingDomains: readonly SendingDomain[];
  healthPolicy?: SenderPoolHealthPolicy;
}

/**
 * Deterministic pick: the usable mailbox with the most remaining capacity,
 * ties broken by mailbox id (stable, no randomness). Returns null when no
 * mailbox in the pool has spare, healthy capacity right now.
 */
export function selectMailboxForSend(input: SenderPoolInput): Mailbox | null {
  const domainsById = new Map(input.sendingDomains.map((d) => [d.id, d]));
  const policy = input.healthPolicy ?? DEFAULT_SENDER_POOL_HEALTH_POLICY;

  const usable = input.mailboxes.filter((mailbox) => isMailboxUsable(mailbox, domainsById.get(mailbox.sendingDomainId), policy));
  if (usable.length === 0) return null;

  return [...usable].sort((a, b) => {
    const capacityDiff = mailboxRemainingCapacity(b) - mailboxRemainingCapacity(a);
    if (capacityDiff !== 0) return capacityDiff;
    return a.id.localeCompare(b.id);
  })[0]!;
}

export interface SenderPoolCapacitySummary {
  totalDailyCapacity: number;
  totalSentToday: number;
  totalRemainingCapacity: number;
  usableMailboxCount: number;
  pausedOrUnhealthyMailboxCount: number;
}

export function summarizeSenderPoolCapacity(input: SenderPoolInput): SenderPoolCapacitySummary {
  const domainsById = new Map(input.sendingDomains.map((d) => [d.id, d]));
  const policy = input.healthPolicy ?? DEFAULT_SENDER_POOL_HEALTH_POLICY;

  let totalDailyCapacity = 0;
  let totalSentToday = 0;
  let totalRemainingCapacity = 0;
  let usableMailboxCount = 0;
  let pausedOrUnhealthyMailboxCount = 0;

  for (const mailbox of input.mailboxes) {
    totalDailyCapacity += mailbox.dailyCapacity;
    totalSentToday += mailbox.sentToday;
    const usable = isMailboxUsable(mailbox, domainsById.get(mailbox.sendingDomainId), policy);
    if (usable) {
      usableMailboxCount += 1;
      totalRemainingCapacity += mailboxRemainingCapacity(mailbox);
    } else {
      pausedOrUnhealthyMailboxCount += 1;
    }
  }

  return { totalDailyCapacity, totalSentToday, totalRemainingCapacity, usableMailboxCount, pausedOrUnhealthyMailboxCount };
}
