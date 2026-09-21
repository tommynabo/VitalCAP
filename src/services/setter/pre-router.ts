import type { SetterBranch } from "@/domain/conversations/types";

/**
 * Deterministic pre-router (Prompt 4 §4.2). Runs before any LLM call and
 * catches the high-confidence cases the spec calls out by name. Order
 * matters: unsubscribe/do-not-contact are checked first and, when matched,
 * `suppress` is always `true` — the caller (the setter orchestrator) must
 * apply that suppression unconditionally and never let a later LLM call
 * override it (§4.2 "Do not let the LLM override a suppression event").
 */

export type PreRouterCategory =
  | "unsubscribe"
  | "do_not_contact"
  | "hard_negative"
  | "out_of_office"
  | "bounce_system_message"
  | "meeting_already_booked"
  | "wrong_person_forward_request"
  | "contact_details_supplied"
  | "automated_spam";

export interface PreRouterResult {
  matched: boolean;
  category: PreRouterCategory | null;
  branch: SetterBranch | null;
  suppress: boolean;
  confidence: number;
}

const NO_MATCH: PreRouterResult = { matched: false, category: null, branch: null, suppress: false, confidence: 0 };

interface PreRouterPattern {
  category: PreRouterCategory;
  branch: SetterBranch;
  suppress: boolean;
  regex: RegExp;
}

const PATTERNS: readonly PreRouterPattern[] = [
  { category: "unsubscribe", branch: "UNSUBSCRIBE", suppress: true, regex: /\b(unsubscribe|(dad|dar)me\s*de\s*baja|de\s*baja\b|no\s*deseo\s*recibir|quitar(me)?\s*de\s*la\s*lista)\b/i },
  { category: "do_not_contact", branch: "UNSUBSCRIBE", suppress: true, regex: /\b(no\s*(me\s*)?contact(e|en|ar|arme)\w*|do\s*not\s*contact|no\s*(vuelva(n)?|vuelvas?|volver)\s*a\s*escribir\w*)\b/i },
  { category: "bounce_system_message", branch: "UNKNOWN", suppress: false, regex: /\b(mail\s*delivery\s*failed|undeliverable|mailer-daemon|delivery\s*status\s*notification)\b/i },
  { category: "out_of_office", branch: "UNKNOWN", suppress: false, regex: /\b(out\s*of\s*office|fuera\s*de\s*la\s*oficina|de\s*vacaciones|ausente\s*hasta)\b/i },
  { category: "meeting_already_booked", branch: "MEETING_REQUEST", suppress: false, regex: /\b(ya\s*(he|hemos)\s*reservado|already\s*booked|meeting\s*confirmed|cita\s*confirmada)\b/i },
  { category: "wrong_person_forward_request", branch: "FORWARD_TO_PURCHASING", suppress: false, regex: /\b(persona\s*equivocada|wrong\s*person|no\s*soy\s*la\s*persona\s*(indicada|adecuada))\b/i },
  { category: "contact_details_supplied", branch: "FORWARD_TO_PURCHASING", suppress: false, regex: /\b(mejor\s*contact[ae]|habla(r)?\s*con|speak\s*with|cont[aá]ctenos?\s*con)\b/i },
  { category: "automated_spam", branch: "UNKNOWN", suppress: false, regex: /\b(this\s*is\s*an\s*automated\s*message|no-?reply@|mensaje\s*automático)\b/i },
  { category: "hard_negative", branch: "NOT_INTERESTED", suppress: false, regex: /\b(no\s*me\s*interesa|not\s*interested|no\s*gracias|no\s*queremos)\b/i },
];

export function detectDeterministicCase(incomingBody: string): PreRouterResult {
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(incomingBody)) {
      return { matched: true, category: pattern.category, branch: pattern.branch, suppress: pattern.suppress, confidence: 0.95 };
    }
  }
  return NO_MATCH;
}
