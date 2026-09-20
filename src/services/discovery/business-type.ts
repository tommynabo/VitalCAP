import type { BusinessType } from "@/domain/accounts/types";

/**
 * Deterministic, rule-based business-type classification (Prompt 2 §2.3:
 * "no expensive LLM call for an obviously-a-pharmacy result — deterministic
 * rules first, AI only for ambiguous cases if the workspace enables it").
 * Returns `"other_retail"` (never throws) when nothing matches, so an
 * ambiguous case can later be routed to an optional LLM classifier without
 * this function needing to change.
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
