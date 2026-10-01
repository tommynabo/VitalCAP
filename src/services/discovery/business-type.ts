import type { BusinessType } from "@/domain/accounts/types";

/**
 * Deterministic, rule-based business-type classification (Prompt 2 §2.3:
 * "no expensive LLM call for an obviously-a-pharmacy result — deterministic
 * rules first, AI only for ambiguous cases if the workspace enables it").
 * The categories outside `ACCEPTED_ICP_BUSINESS_TYPES` are retained as raw
 * classifications for auditability, but they are never ICP-qualified.
 */
const RULES: Array<{ type: BusinessType; keywords: RegExp }> = [
  { type: "pharmacy", keywords: /\bfarmacia\b/i },
  { type: "parapharmacy", keywords: /\bparafarmacia\b/i },
  { type: "herbal_shop", keywords: /\bherbolari[oa]\b/i },
  { type: "sports_nutrition_store", keywords: /nutrici[oó]n\s+deportiva/i },
  { type: "supplement_store", keywords: /suplement|complement/i },
];

export function classifyBusinessType(text: string | null | undefined): BusinessType {
  const value = text?.trim() ?? "";
  if (!value) return "other_retail";
  for (const rule of RULES) {
    if (rule.keywords.test(value)) return rule.type;
  }
  return "other_retail";
}

/** Canonical Vitalcap ICP: only these business types may be qualified. */
export const ACCEPTED_ICP_BUSINESS_TYPES = ["pharmacy", "parapharmacy", "herbal_shop"] as const satisfies readonly BusinessType[];

export function isAcceptedIcpBusinessType(type: BusinessType): type is (typeof ACCEPTED_ICP_BUSINESS_TYPES)[number] {
  return (ACCEPTED_ICP_BUSINESS_TYPES as readonly BusinessType[]).includes(type);
}
