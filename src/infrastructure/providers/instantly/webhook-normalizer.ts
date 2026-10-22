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
  const providerLeadId = firstString(data.lead_email, data.email, lead?.email, data.from_email, data.lead_id);
  if (!providerLeadId) return null;

  return {
    providerLeadId,
    providerEventId,
    code: domainCode,
    occurredAt: occurredAt.toISOString(),
    raw: data,
    providerMessageId: firstString(data.email_id, data.message_id, data.id),
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
  const emailData = record(data.email);
  const providerCampaignId = firstString(data.campaign_id, data.campaignId, data.campaign_uuid, campaign?.id);
  const email = firstString(data.lead_email, data.email_address, data.from_email, data.from_address_email, data.email, lead?.email)?.toLowerCase() ?? null;
  const providerMessageId = firstString(data.reply_id, data.reply_uuid, data.message_id, data.email_id, reply?.id, reply?.uuid, emailData?.id);
  const providerEventId = firstString(data.event_id, root.event_id, data.webhook_event_id, root.webhook_event_id, data.id, root.id, providerMessageId);
  const bodyData = record(data.body);
  const body = firstString(data.reply_text, data.reply_text_snippet, data.reply_html, data.text, data.email_body, bodyData?.text, reply?.text, reply?.body);
  if (!providerCampaignId || !email || !providerEventId || !providerMessageId || !body) return null;

  const explicitThreadId = firstString(data.thread_id, data.email_thread_id, data.conversation_id, reply?.thread_id, emailData?.thread_id);
  const occurredAtValue = firstString(data.timestamp, data.created_at, data.timestamp_created, data.timestamp_email, data.event_timestamp, root.timestamp);
  const parsedAt = occurredAtValue ? new Date(occurredAtValue) : now;

  return {
    eventType,
    providerEventId,
    providerMessageId,
    providerThreadId: explicitThreadId ?? `${providerCampaignId}:${email}`,
    providerCampaignId,
    email,
    subject: firstString(data.reply_subject, data.subject, data.email_subject, reply?.subject, emailData?.subject) ?? "",
    body,
    occurredAt: Number.isNaN(parsedAt.getTime()) ? now.toISOString() : parsedAt.toISOString(),
    ...(firstString(data.reply_to_uuid, data.email_id) ? { replyToUuid: firstString(data.reply_to_uuid, data.email_id) } : {}),
    emailAccount: firstString(data.email_account, data.eaccount, data.sending_email, data.email_account_email),
    workspace: firstString(data.workspace),
    campaignName: firstString(data.campaign_name, campaign?.name),
  };
}
