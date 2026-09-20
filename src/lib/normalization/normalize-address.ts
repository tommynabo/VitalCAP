const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bc\/\s*/g, "calle "],
  [/\bavda\.?\s*/g, "avenida "],
  [/\bavd\.?\s*/g, "avenida "],
  [/\bpza\.?\s*/g, "plaza "],
  [/\bplza\.?\s*/g, "plaza "],
  [/\bctra\.?\s*/g, "carretera "],
  [/\bn[º°]\.?\s*/g, "numero "],
  [/\bnum\.?(?![a-z])\s*/g, "numero "],
];

/** Strip diacritics for accent-insensitive matching, without altering base letters. */
function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalize a Spanish street address for dedup matching (Prompt 1 §1.3):
 * lowercase, accent-insensitive, common abbreviations expanded (c/ →
 * calle, avda → avenida, pza → plaza, nº → numero), punctuation/whitespace
 * collapsed.
 */
export function normalizeAddress(input: string | null | undefined): string {
  if (!input) return "";

  let value = stripAccents(input.trim().toLowerCase());
  for (const [pattern, replacement] of ABBREVIATIONS) {
    value = value.replace(pattern, replacement);
  }

  return value
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
