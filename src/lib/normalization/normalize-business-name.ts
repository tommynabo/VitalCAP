/** Strip diacritics for accent-insensitive matching, without altering base letters. */
function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalize a business name for dedup matching (Prompt 1 §1.3). Deliberately
 * conservative: lowercases, strips accents/punctuation and collapses
 * whitespace, but never removes legal-form suffixes (e.g. "S.L.") since
 * that can discard meaningful, disambiguating information.
 */
export function normalizeBusinessName(input: string | null | undefined): string {
  if (!input) return "";

  return stripAccents(input.trim().toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
