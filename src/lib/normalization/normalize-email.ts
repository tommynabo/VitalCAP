const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize an email for dedup/storage (Prompt 1 §1.3). Lowercases the full
 * address (mailboxes are almost always case-insensitive in practice) and
 * rejects anything that doesn't look like a real address.
 */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;

  const value = input.trim().toLowerCase();
  if (!value || !EMAIL_SHAPE.test(value)) return null;

  const [local, domain] = value.split("@");
  if (!local || !domain || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;

  return value;
}
