import type { DesiredChannelMix } from "@/domain/campaigns/types";
import type { ContactPointType } from "@/domain/contacts/types";

/**
 * Channel mix planner (Prompt 3 §3.6). Given a campaign's desired mix (e.g.
 * 125 email / 125 SMS per day) plus what has already gone out today and how
 * much sender capacity remains, computes how many more of each channel can
 * still be attempted today and reports any capacity-driven shortfall.
 *
 * This planner never selects accounts or bypasses suppression/eligibility —
 * it only produces a count budget per channel. The actual account/contact
 * selection always goes through `routeAccountToEndpoint` +
 * `SuppressionAwareComplianceGate` regardless of what this plan says, so a
 * mix target can never be used to justify sending to an ineligible or
 * suppressed contact.
 */

export type MixChannel = "email" | "sms";

export function mixChannelForContactPointType(type: ContactPointType): MixChannel | null {
  if (type === "email") return "email";
  if (type === "phone") return "sms";
  return null;
}

export interface ChannelMixInput {
  desiredMix: DesiredChannelMix;
  sentTodayByChannel: Record<MixChannel, number>;
  remainingCapacityByChannel: Record<MixChannel, number>;
}

export interface ChannelMixAllocation {
  channel: MixChannel;
  desired: number;
  sentToday: number;
  remainingTarget: number;
  allocatable: number;
  shortfall: number;
}

export interface ChannelMixPlan {
  allocations: ChannelMixAllocation[];
  totalShortfall: number;
}

const CHANNELS: readonly MixChannel[] = ["email", "sms"];

export function planChannelMix(input: ChannelMixInput): ChannelMixPlan {
  const allocations = CHANNELS.map((channel): ChannelMixAllocation => {
    const desired = input.desiredMix[channel];
    const sentToday = input.sentTodayByChannel[channel];
    const remainingTarget = Math.max(0, desired - sentToday);
    const remainingCapacity = Math.max(0, input.remainingCapacityByChannel[channel]);
    const allocatable = Math.min(remainingTarget, remainingCapacity);
    const shortfall = Math.max(0, remainingTarget - allocatable);
    return { channel, desired, sentToday, remainingTarget, allocatable, shortfall };
  });

  const totalShortfall = allocations.reduce((sum, allocation) => sum + allocation.shortfall, 0);
  return { allocations, totalShortfall };
}
