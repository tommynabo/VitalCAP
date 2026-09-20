/**
 * Normalize a Spanish phone number to canonical `+34XXXXXXXXX` form
 * (Prompt 1 §1.3). Accepts `+34`, `0034`, or a bare 9-digit national number
 * starting with 6/7/8/9 (mobile/landline). Returns `null` for anything that
 * doesn't resolve to a plausible Spanish number.
 */
export function normalizePhoneES(input: string | null | undefined): string | null {
  if (!input) return null;

  let digits = input.trim().replace(/[\s().-]/g, "");
  if (!digits) return null;

  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("34") && digits.length === 11) {
    digits = digits.slice(2);
  }

  if (!/^\d{9}$/.test(digits)) return null;
  if (!/^[6789]/.test(digits)) return null;

  return `+34${digits}`;
}
