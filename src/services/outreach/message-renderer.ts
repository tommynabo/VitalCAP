import type { Offer } from "@/domain/campaigns/types";

/**
 * Minimal, non-LLM message renderer (Prompt 3 §3.12 "render message" step).
 * Only whitelisted placeholders backed by an `Offer` record or contact/
 * account facts may be substituted — anything else is left untouched and
 * reported in `missingPlaceholders` so a human reviews it before send. No
 * commercial fact is ever invented here; every substitution traces back to
 * an `Offer`-approved field.
 */

export interface MessageTemplateContext {
  contactFirstName: string | null;
  accountName: string;
  offer: Offer;
}

export interface RenderedMessage {
  body: string;
  usedPlaceholders: string[];
  missingPlaceholders: string[];
}

function resolvePlaceholders(context: MessageTemplateContext): Record<string, string | null> {
  return {
    contact_first_name: context.contactFirstName,
    account_name: context.accountName,
    offer_company: context.offer.company,
    offer_description: context.offer.description,
    offer_primary_cta: context.offer.primaryCta,
    offer_booking_url: context.offer.bookingUrl,
  };
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderMessageTemplate(template: string, context: MessageTemplateContext): RenderedMessage {
  const values = resolvePlaceholders(context);
  const usedPlaceholders: string[] = [];
  const missingPlaceholders: string[] = [];

  const body = template.replace(PLACEHOLDER_PATTERN, (fullMatch, key: string) => {
    if (!(key in values)) {
      missingPlaceholders.push(key);
      return fullMatch;
    }
    usedPlaceholders.push(key);
    return values[key] ?? "";
  });

  return { body, usedPlaceholders, missingPlaceholders };
}
