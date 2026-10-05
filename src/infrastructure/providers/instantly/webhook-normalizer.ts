import type { EmailDeliveryStatusCode, EmailDeliveryStatusEvent, InboundEmailReply } from "@/domain/providers/types";

/**
 * Normalizes Instantly v2 webhooks into standard Domain events.
 */
export function normalizeInstantlyWebhook(
  payload: unknown,
  providerEventId: string,
  occurredAt: Date
): EmailDeliveryStatusEvent | null {
  const root = record(payload);
  const data = record(root?.data) ?? root;
  const eventType = firstString(data?.event_type, root?.event_type);
  if (!data || !eventType) return null;

  const emailCodeMap: Record<string, EmailDeliveryStatusCode> = {
    "email_sent": "sent",
    "email_opened": "delivered", // Instantly doesn't always have a strict delivered webhook, uses open
    "email_bounced": "bounced",
    "email_replied": "replied",
    "reply_received": "replied",
    "lead_unsubscribed": "unsubscribed"
  };

  const domainCode = emailCodeMap[eventType];
  if (!domainCode) return null;

  const lead = record(data.lead);
  const providerLeadId = firstString(data.lead_id, data.lead_email, data.email, lead?.email);
  if (!providerLeadId) return null;

  return {
    providerLeadId,
    providerEventId,
    code: domainCode,
    occurredAt: occurredAt.toISOString(),
    raw: data
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Normalizes only actual reply events; required provider ids are never fabricated. */
export function normalizeInstantlyInboundReply(payload: unknown, now = new Date()): InboundEmailReply | null {
  const root = record(payload);
  const data = record(root?.data) ?? root;
  const eventType = firstString(data?.event_type, root?.event_type);
  if (!root || !data || (eventType !== "email_replied" && eventType !== "reply_received")) return null;

  const campaign = record(data.campaign);
  const lead = record(data.lead);
  const reply = record(data.reply);
  const providerCampaignId = firstString(data.campaign_id, data.campaignId, campaign?.id);
  const email = firstString(data.lead_email, data.email, lead?.email, data.from_email)?.toLowerCase() ?? null;
  const providerMessageId = firstString(data.message_id, data.email_id, data.reply_id, reply?.id);
  const providerEventId = firstString(data.event_id, root.event_id, data.webhook_event_id, root.webhook_event_id, data.id, root.id, providerMessageId);
  const body = firstString(data.reply_text, data.text, data.body, data.email_body, reply?.text);
  if (!providerCampaignId || !email || !providerEventId || !providerMessageId || !body) return null;

  const explicitThreadId = firstString(data.thread_id, data.email_thread_id, data.conversation_id, reply?.thread_id);
  const occurredAtValue = firstString(data.timestamp, data.created_at, data.event_timestamp, root.timestamp);
  const parsedAt = occurredAtValue ? new Date(occurredAtValue) : now;

  return {
    eventType,
    providerEventId,
    providerMessageId,
    providerThreadId: explicitThreadId ?? `${providerCampaignId}:${email}`,
    providerCampaignId,
    email,
    subject: firstString(data.reply_subject, data.subject, data.email_subject, reply?.subject) ?? "",
    body,
    occurredAt: Number.isNaN(parsedAt.getTime()) ? now.toISOString() : parsedAt.toISOString(),
    emailAccount: firstString(data.email_account, data.eaccount),
    workspace: firstString(data.workspace),
    campaignName: firstString(data.campaign_name, campaign?.name),
  };
}
