import type { ContactPoint, ContactPointType } from "@/domain/contacts/types";
import type { OutreachEventState, OutreachQueueItem, SuppressionEntry } from "@/domain/outreach/types";
import { checkSuppression } from "@/services/compliance/suppression-service";
import { evaluateChannelEligibility } from "@/services/compliance/compliance-gate";
import { isContactPointAcceptable, DEFAULT_VERIFICATION_ACCEPTANCE_POLICY, type VerificationAcceptancePolicy } from "@/services/verification/acceptance-policy";

/**
 * Deterministic `ChannelRouter` (Prompt 3 §3.2). Selects at most one active
 * contact point per account per call — the default posture is exactly one
 * concurrent cold outreach path per account (never `owner@` + `info@`
 * simultaneously) unless a campaign explicitly opts into
 * `allowMultiEndpointPerAccount`. Endpoint ranking reuses Phase 1's
 * `computeStrategicPriority` output (`ContactPoint.priorityScore`) rather
 * than re-encoding the owner > purchasing > manager > other-named >
 * role-email > pharmacy-generic > info@ ladder a second time — that scoring
 * table already *is* this ladder (100 down to 50).
 */

const ACTIVE_STATES: ReadonlySet<OutreachEventState> = new Set(["queued", "scheduled", "provider_submitted", "sent"]);

export interface ChannelRouterOptions {
  allowMultiEndpointPerAccount: boolean;
  accountCooldownMs: number;
  verificationPolicy: VerificationAcceptancePolicy;
}

export const DEFAULT_CHANNEL_ROUTER_OPTIONS: ChannelRouterOptions = {
  allowMultiEndpointPerAccount: false,
  accountCooldownMs: 7 * 24 * 60 * 60 * 1000,
  verificationPolicy: DEFAULT_VERIFICATION_ACCEPTANCE_POLICY,
};

export interface RouteAccountInput {
  accountId: string;
  contactPoints: readonly ContactPoint[];
  existingQueueItems: readonly OutreachQueueItem[];
  suppressionEntries: readonly SuppressionEntry[];
  now: Date;
  /** Restrict selection to one channel (e.g. an SMS-only routing pass); omit to consider email first, then phone. */
  preferredChannel?: ContactPointType;
}

export type RouteBlockedReason =
  | "concurrent_active_path"
  | "account_cooldown"
  | "no_eligible_endpoint"
  | "suppressed";

export interface RouteDecision {
  accountId: string;
  selectedContactPointId: string | null;
  channel: ContactPointType | null;
  blockedReason: RouteBlockedReason | null;
}

function isCandidateEligible(cp: ContactPoint, policy: VerificationAcceptancePolicy): boolean {
  if (!evaluateChannelEligibility(cp.type, cp.channelEligibility)) return false;
  if (cp.type === "email") return isContactPointAcceptable(cp.verificationStatus, policy);
  return true;
}

export function routeAccountToEndpoint(input: RouteAccountInput, options: Partial<ChannelRouterOptions> = {}): RouteDecision {
  const opts = { ...DEFAULT_CHANNEL_ROUTER_OPTIONS, ...options };

  const accountSuppression = checkSuppression({ contactPointId: null, accountId: input.accountId }, input.suppressionEntries);
  if (accountSuppression.suppressed) {
    return { accountId: input.accountId, selectedContactPointId: null, channel: null, blockedReason: "suppressed" };
  }

  if (!opts.allowMultiEndpointPerAccount) {
    const hasActivePath = input.existingQueueItems.some(
      (item) => item.accountId === input.accountId && ACTIVE_STATES.has(item.state),
    );
    if (hasActivePath) {
      return { accountId: input.accountId, selectedContactPointId: null, channel: null, blockedReason: "concurrent_active_path" };
    }
  }

  const lastContactedAtMs = input.contactPoints.reduce<number | null>((latest, cp) => {
    if (!cp.lastContactedAt) return latest;
    const ts = new Date(cp.lastContactedAt).getTime();
    return latest === null || ts > latest ? ts : latest;
  }, null);
  if (lastContactedAtMs !== null && input.now.getTime() - lastContactedAtMs < opts.accountCooldownMs) {
    return { accountId: input.accountId, selectedContactPointId: null, channel: null, blockedReason: "account_cooldown" };
  }

  const channelsToTry: ContactPointType[] = input.preferredChannel ? [input.preferredChannel] : ["email", "phone"];
  for (const channel of channelsToTry) {
    const candidates = input.contactPoints
      .filter((cp) => cp.type === channel)
      .filter((cp) => {
        const suppression = checkSuppression({ contactPointId: cp.id, accountId: null }, input.suppressionEntries);
        return !suppression.suppressed && isCandidateEligible(cp, opts.verificationPolicy);
      })
      .sort((a, b) => b.priorityScore - a.priorityScore);

    if (candidates.length > 0) {
      return { accountId: input.accountId, selectedContactPointId: candidates[0]!.id, channel, blockedReason: null };
    }
  }

  return { accountId: input.accountId, selectedContactPointId: null, channel: null, blockedReason: "no_eligible_endpoint" };
}
