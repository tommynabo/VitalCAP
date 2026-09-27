import { EmailDeliveryStatusCode, EmailDeliveryStatusEvent } from "@/domain/providers/types";

/**
 * Normalizes Instantly v2 webhooks into standard Domain events.
 */
export function normalizeInstantlyWebhook(
  payload: any,
  providerEventId: string,
  occurredAt: Date
): EmailDeliveryStatusEvent | null {
  
  if (!payload || !payload.event_type) {
    return null; // unrecognized
  }

  const emailCodeMap: Record<string, EmailDeliveryStatusCode> = {
    "email_sent": "sent",
    "email_opened": "delivered", // Instantly doesn't always have a strict delivered webhook, uses open
    "email_bounced": "bounced",
    "email_replied": "replied",
    "lead_unsubscribed": "unsubscribed"
  };

  const domainCode = emailCodeMap[payload.event_type];
  if (!domainCode) return null;

  return {
    providerLeadId: payload.lead_id || payload.email, // fallback to email if ID missing
    providerEventId,
    code: domainCode,
    occurredAt: occurredAt.toISOString(),
    raw: payload
  };
}
