import type { BusinessType } from "@/domain/accounts/types";
import type { NicheId } from "./niche-profiles";

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

const NICHE_RULES: Record<NicheId, { type: BusinessType; include: RegExp; exclude: RegExp }> = {
  yoga_pilates: {
    type: "yoga_pilates_studio",
    include: /\b(yoga|pilates)\b/i,
    exclude: /\b(gimnasio|gym|fitness club|municipal|asociaci[oó]n)\b/i,
  },
  spas_wellness: {
    type: "spa_wellness_center",
    include: /\b(spa|wellness|bienestar|masaje|masajes|hol[ií]stic[oa])\b/i,
    exclude: /\b(hotel|resort)\b/i,
  },
  premium_fitness: {
    type: "premium_fitness_center",
    include: /\b(boutique|funcional|fuerza|acondicionamiento|premium|personal training|entrenamiento personal)\b/i,
    exclude: /\b(low[ -]?cost|municipal|p[uú]blic[oa]|alquiler de instalaciones)\b/i,
  },
  personal_training: {
    type: "personal_training_studio",
    include: /\b(estudio|centro|studio)\b.*\b(entrenamiento personal|personal training|entrenador personal)\b|\b(entrenamiento personal|personal training|entrenador personal)\b.*\b(estudio|centro|studio)\b/i,
    exclude: /\b(online|a domicilio|freelance|freelancer)\b/i,
  },
};

export function classifyNicheBusinessType(text: string | null | undefined, niche: NicheId): BusinessType {
  const value = text?.trim() ?? "";
  const rule = NICHE_RULES[niche];
  return value && !rule.exclude.test(value) && rule.include.test(value) ? rule.type : "other_retail";
}

/** Canonical Vitalcap ICP: only these business types may be qualified. */
export const ACCEPTED_ICP_BUSINESS_TYPES = ["pharmacy", "parapharmacy", "herbal_shop"] as const satisfies readonly BusinessType[];

export function isAcceptedIcpBusinessType(type: BusinessType): type is (typeof ACCEPTED_ICP_BUSINESS_TYPES)[number] {
  return (ACCEPTED_ICP_BUSINESS_TYPES as readonly BusinessType[]).includes(type);
}

export function isAcceptedNicheBusinessType(type: BusinessType, niche: NicheId): boolean {
  return type === NICHE_RULES[niche].type;
}
