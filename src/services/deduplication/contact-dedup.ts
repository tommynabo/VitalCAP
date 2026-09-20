export interface ContactIdentitySignals {
  contactId: string;
  accountId: string;
  normalizedFullName: string | null;
  normalizedEmail?: string | null;
  normalizedPhone?: string | null;
  normalizedLinkedInUrl?: string | null;
}

export type ContactDedupSignal = "normalized_email" | "normalized_phone" | "normalized_linkedin_url" | "full_name_account";

export interface ContactDedupMatch {
  contactId: string;
  signal: ContactDedupSignal;
  confidence: number;
}

export type ContactDedupAction = "merge" | "no_match";

export interface ContactDedupDecision {
  action: ContactDedupAction;
  matches: ContactDedupMatch[];
  confidence: number;
}

const STRONG_CONFIDENCE = 0.95;
const COMPOSITE_CONFIDENCE = 0.75;

/**
 * Evaluates whether `incoming` is the same person as an existing contact on
 * the SAME account (Prompt 1 §1.2). Strong: exact normalized email/phone/
 * LinkedIn URL. Composite: exact normalized full name on the same account.
 * Different named people at the same account (different full names, no
 * shared endpoint) must never match — a pharmacy legitimately has several
 * distinct contacts.
 */
export function evaluateContactDedup(
  incoming: Omit<ContactIdentitySignals, "contactId">,
  existingOnSameAccount: readonly ContactIdentitySignals[],
): ContactDedupDecision {
  const matches: ContactDedupMatch[] = [];

  for (const candidate of existingOnSameAccount) {
    if (candidate.accountId !== incoming.accountId) continue;

    if (incoming.normalizedEmail && candidate.normalizedEmail && incoming.normalizedEmail === candidate.normalizedEmail) {
      matches.push({ contactId: candidate.contactId, signal: "normalized_email", confidence: STRONG_CONFIDENCE });
    }
    if (incoming.normalizedPhone && candidate.normalizedPhone && incoming.normalizedPhone === candidate.normalizedPhone) {
      matches.push({ contactId: candidate.contactId, signal: "normalized_phone", confidence: STRONG_CONFIDENCE });
    }
    if (
      incoming.normalizedLinkedInUrl &&
      candidate.normalizedLinkedInUrl &&
      incoming.normalizedLinkedInUrl === candidate.normalizedLinkedInUrl
    ) {
      matches.push({ contactId: candidate.contactId, signal: "normalized_linkedin_url", confidence: STRONG_CONFIDENCE });
    }
  }

  if (matches.length > 0) {
    return { action: "merge", matches, confidence: Math.max(...matches.map((m) => m.confidence)) };
  }

  for (const candidate of existingOnSameAccount) {
    if (candidate.accountId !== incoming.accountId) continue;
    if (incoming.normalizedFullName && candidate.normalizedFullName && incoming.normalizedFullName === candidate.normalizedFullName) {
      matches.push({ contactId: candidate.contactId, signal: "full_name_account", confidence: COMPOSITE_CONFIDENCE });
    }
  }

  if (matches.length > 0) {
    return { action: "merge", matches, confidence: COMPOSITE_CONFIDENCE };
  }

  return { action: "no_match", matches: [], confidence: 0 };
}
