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
    .map((message) => ({ direction: message.direction, body: message.body }));

  const recentFeedbackNotes = input.recentFeedback
    .slice(-MAX_RECENT_FEEDBACK_NOTES)
    .map((feedback) => feedback.note)
    .filter((note): note is string => Boolean(note));

  return {
    language: input.language,
    offer: {
      company: input.offer.company,
      description: input.offer.description,
      primaryCta: input.offer.primaryCta,
      bookingUrl: input.offer.bookingUrl,
      approvedCommercialFacts: input.offer.approvedCommercialFacts,
      approvedProductFacts: input.offer.approvedProductFacts,
      approvedClaims: input.offer.approvedClaims,
      forbiddenClaims: input.offer.forbiddenClaims,
      faq: input.offer.faq,
      objectionGuidance: input.offer.objectionGuidance,
      toneConfig: input.offer.toneConfig,
    },
    account: { name: input.account.canonicalName, businessType: input.account.businessType },
    contact: input.contact ? { roleType: input.contact.roleType, firstName: input.contact.firstName } : null,
    discoverySource: input.discoverySource,
    recentMessages,
    recentFeedbackNotes,
    latestIncomingMessage: input.latestIncomingMessage,
    isRepairAttempt: input.isRepairAttempt ?? false,
  };
}
