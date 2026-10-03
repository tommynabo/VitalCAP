import type { Account } from "@/domain/accounts/types";
import type { Offer } from "@/domain/campaigns/types";
import type { Contact } from "@/domain/contacts/types";
import type { ConversationMessage, SetterFeedback } from "@/domain/conversations/types";
import type { SetterPromptContext } from "@/domain/providers/types";

/**
 * Setter context builder (Prompt 4 §4.4). Assembles a bounded, whitelisted
 * context object for the LLM from configuration only — never a raw DB dump.
 * Recency caps keep the prompt from growing unbounded as a conversation or
 * the feedback corpus accumulates (§4.8 "do not create uncontrolled prompt
 * growth").
 */
const MAX_RECENT_MESSAGES = 10;
const MAX_RECENT_FEEDBACK_NOTES = 5;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_FIELD_CHARS = 1_200;

function limitValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, MAX_FIELD_CHARS);
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => limitValue(item, depth + 1));
  if (!value || typeof value !== "object" || depth >= 2) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key.slice(0, 80), limitValue(item, depth + 1)]));
}

function limitStringRecord(value: Record<string, unknown>): Record<string, unknown> {
  return limitValue(value) as Record<string, unknown>;
}

function limitStringMap(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key.slice(0, 80), item.slice(0, MAX_FIELD_CHARS)]));
}

export interface BuildSetterContextInput {
  offer: Offer;
  account: Account;
  contact: Contact | null;
  discoverySource: string | null;
  conversationMessages: readonly ConversationMessage[];
  recentFeedback: readonly SetterFeedback[];
  latestIncomingMessage: string;
  language: string;
  isRepairAttempt?: boolean;
}

export function buildSetterContext(input: BuildSetterContextInput): SetterPromptContext {
  const recentMessages = input.conversationMessages
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => ({ direction: message.direction, body: message.body.slice(0, MAX_MESSAGE_CHARS) }));

  const recentFeedbackNotes = input.recentFeedback
    .slice(-MAX_RECENT_FEEDBACK_NOTES)
    .map((feedback) => feedback.note?.slice(0, MAX_FIELD_CHARS))
    .filter((note): note is string => Boolean(note));

  return {
    language: input.language,
    offer: {
      company: input.offer.company.slice(0, MAX_FIELD_CHARS),
      description: input.offer.description.slice(0, MAX_MESSAGE_CHARS),
      primaryCta: input.offer.primaryCta.slice(0, MAX_FIELD_CHARS),
      bookingUrl: input.offer.bookingUrl.slice(0, MAX_FIELD_CHARS),
      approvedCommercialFacts: limitStringRecord(input.offer.approvedCommercialFacts),
      approvedProductFacts: limitStringRecord(input.offer.approvedProductFacts),
      approvedClaims: input.offer.approvedClaims.slice(0, 20).map((claim) => claim.slice(0, MAX_FIELD_CHARS)),
      forbiddenClaims: input.offer.forbiddenClaims.slice(0, 20).map((claim) => claim.slice(0, MAX_FIELD_CHARS)),
      faq: input.offer.faq.slice(0, 10).map((item) => ({ question: item.question.slice(0, MAX_FIELD_CHARS), answer: item.answer.slice(0, MAX_MESSAGE_CHARS) })),
      objectionGuidance: limitStringMap(input.offer.objectionGuidance),
      toneConfig: limitStringRecord(input.offer.toneConfig),
    },
    account: { name: input.account.canonicalName.slice(0, MAX_FIELD_CHARS), businessType: input.account.businessType },
    contact: input.contact ? { roleType: input.contact.roleType, firstName: input.contact.firstName?.slice(0, MAX_FIELD_CHARS) ?? null } : null,
    discoverySource: input.discoverySource?.slice(0, MAX_FIELD_CHARS) ?? null,
    recentMessages,
    recentFeedbackNotes,
    latestIncomingMessage: input.latestIncomingMessage.slice(0, MAX_MESSAGE_CHARS),
    isRepairAttempt: input.isRepairAttempt ?? false,
  };
}
