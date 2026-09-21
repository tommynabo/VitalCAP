import type { SetterPromptContext } from "@/domain/providers/types";
import type { ValidatedSetterOutput } from "./setter-output-schema";

/**
 * Guardrails (Prompt 4 §4.6). Runs *after* the LLM/mock provider produces
 * (and Zod-validates) an output, and independently forces `needsHuman` when
 * the draft or the lead's request crosses one of the lines the spec calls
 * out — it never trusts the model's own `needsHuman` flag for these cases.
 */

type ClaimCategory = "medical_therapeutic_claim" | "certification_claim" | "legal_regulatory_claim" | "pharmacy_performance_claim";
type FactCategory =
  | "pricing_claim"
  | "margin_claim"
  | "minimum_order_claim"
  | "shipping_time_claim"
  | "stock_claim"
  | "exclusivity_claim"
  | "historical_sales_claim"
  | "distribution_terms_claim";

const CLAIM_PATTERNS: Record<ClaimCategory, RegExp> = {
  medical_therapeutic_claim: /\b(cura|curar|tratamiento|terap[eé]utic\w*|therapeutic|treats?|cures?)\b/i,
  certification_claim: /\b(certificad\w*|certified|iso\s?\d+)\b/i,
  legal_regulatory_claim: /\b(regulatori\w*|regulatory|aemps|legalmente\s?aprobado)\b/i,
  pharmacy_performance_claim: /\b(rendimiento\s?de\s?farmacia|pharmacy\s?performance)\b/i,
};

/** Maps each forbidden-claim category to the offer.forbiddenClaims label(s) that cover it. */
const CLAIM_FORBIDDEN_LABELS: Record<ClaimCategory, RegExp> = {
  medical_therapeutic_claim: /therapeutic|medical/i,
  certification_claim: /certif/i,
  legal_regulatory_claim: /legal|regulatory/i,
  pharmacy_performance_claim: /performance/i,
};

const FACT_PATTERNS: Record<FactCategory, RegExp> = {
  pricing_claim: /\b(precio|price|€|\bpvp\b)\b/i,
  margin_claim: /\b(margen|margin)\b/i,
  minimum_order_claim: /\b(pedido\s?m[ií]nimo|minimum\s?order|moq)\b/i,
  shipping_time_claim: /\b(env[ií]o\s?en\s?\d|plazo\s?de\s?entrega|shipping\s?time|delivery\s?time)\b/i,
  stock_claim: /\b(stock|en\s?existencia|disponibilidad\s?inmediata)\b/i,
  exclusivity_claim: /\b(exclusiv\w*|territorio\s?exclusivo|exclusive\s?territory)\b/i,
  historical_sales_claim: /\b(ventas\s?hist[oó]ricas|historical\s?sales)\b/i,
  distribution_terms_claim: /\b(t[eé]rminos\s?de\s?distribuci[oó]n|distribution\s?terms)\b/i,
};

/** Maps each fact category to the key pattern that must exist in approved offer facts to be "grounded". */
const FACT_GROUNDING_KEY_PATTERNS: Record<FactCategory, RegExp> = {
  pricing_claim: /price/i,
  margin_claim: /margin/i,
  minimum_order_claim: /min(imum)?order|moq/i,
  shipping_time_claim: /shipping|delivery/i,
  stock_claim: /stock/i,
  exclusivity_claim: /exclusiv|territory/i,
  historical_sales_claim: /sales|historical/i,
  distribution_terms_claim: /distribution/i,
};

const NEGOTIATION_PATTERN =
  /\b(precio\s?especial|special\s?price|descuento|discount|condiciones\s?personalizadas|custom\s?terms|gran\s?volumen|large\s?volume|acuerdo\s?de\s?volumen|volume\s?agreement|territorio\s?exclusivo|exclusive\s?territory)\b/i;

export interface GuardrailResult {
  output: ValidatedSetterOutput;
  triggered: string[];
}

function approvedFactKeys(context: SetterPromptContext): string[] {
  return [...Object.keys(context.offer.approvedCommercialFacts), ...Object.keys(context.offer.approvedProductFacts)];
}

export function applyGuardrails(output: ValidatedSetterOutput, context: SetterPromptContext): GuardrailResult {
  const triggered: string[] = [];
  const riskFlags = new Set(output.riskFlags);
  let needsHuman = output.needsHuman;
  let reasonForHuman = output.reasonForHuman;

  const escalate = (code: string, reason: string) => {
    triggered.push(code);
    riskFlags.add(code);
    needsHuman = true;
    reasonForHuman = reasonForHuman ?? reason;
  };

  if (NEGOTIATION_PATTERN.test(context.latestIncomingMessage)) {
    escalate(
      "commercial_negotiation_requires_human",
      "Lead is requesting non-approved commercial terms (special price, discount, exclusivity, territory, or volume agreement) — requires human negotiation.",
    );
  }

  for (const [category, pattern] of Object.entries(CLAIM_PATTERNS) as Array<[ClaimCategory, RegExp]>) {
    if (!pattern.test(output.draft)) continue;
    const forbiddenLabelPattern = CLAIM_FORBIDDEN_LABELS[category];
    const isForbidden = context.offer.forbiddenClaims.some((label) => forbiddenLabelPattern.test(label));
    if (isForbidden) {
      escalate(category, `Draft references a forbidden claim category ("${category}") explicitly listed in the offer's forbiddenClaims.`);
    }
  }

  const groundedKeys = approvedFactKeys(context);
  for (const [category, pattern] of Object.entries(FACT_PATTERNS) as Array<[FactCategory, RegExp]>) {
    if (!pattern.test(output.draft)) continue;
    const groundingPattern = FACT_GROUNDING_KEY_PATTERNS[category];
    const isGrounded = groundedKeys.some((key) => groundingPattern.test(key));
    if (!isGrounded) {
      escalate(category, `Draft references "${category}" without a matching approved commercial/product fact.`);
    }
  }

  return {
    output: { ...output, needsHuman, reasonForHuman, riskFlags: Array.from(riskFlags) },
    triggered,
  };
}
