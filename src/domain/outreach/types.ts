/**
 * Domain types for outreach delivery infrastructure (Prompt 1 §1.1,
 * Prompt 3). Delivery state machine mirrors Appendix B. `deliveryMode`
 * defaults to `dry_run` everywhere — flipping to `live` is an explicit,
 * per-campaign operator action, never a code default.
 */

import type { ContactPointType } from "@/domain/contacts/types";

export type OutreachEventState =
  | "queued"
  | "scheduled"
  | "provider_submitted"
  | "sent"
  | "delivered"
  | "replied"
  | "failed"
  | "bounced"
  | "unsubscribed"
  | "canceled"
  | "suppressed";

export type DeliveryMode = "dry_run" | "live";

export interface OutreachQueueItem {
  id: string;
  campaignId: string;
  accountId: string;
  contactId: string | null;
  contactPointId: string;
  channel: ContactPointType;
  priority: number;
  scheduledFor: string | null;
  state: OutreachEventState;
  deliveryMode: DeliveryMode;
}

export interface OutreachEvent {
  id: string;
  outreachQueueItemId: string;
  state: OutreachEventState;
  providerEventId: string | null;
  payloadHash: string | null;
  occurredAt: string;
}

export interface SendingDomain {
  id: string;
  domain: string;
  status: "connected" | "degraded" | "paused" | "missing_configuration";
  warmupStatus: "warming" | "warm" | "unknown";
}

export interface Mailbox {
  id: string;
  sendingDomainId: string;
  email: string;
  dailyCapacity: number;
  sentToday: number;
  bounceRate: number;
  replyRate: number;
  healthScore: number;
  pausedReason: string | null;
}

export type SuppressionReason =
  | "unsubscribe"
  | "sms_stop"
  | "permanent_bounce"
  | "manual_block"
  | "compliance_block"
  | "account_do_not_contact"
  | "provider_unsubscribe";

export interface SuppressionEntry {
  id: string;
  workspaceId: string;
  contactPointId: string | null;
  accountId: string | null;
  reason: SuppressionReason;
  createdAt: string;
}
