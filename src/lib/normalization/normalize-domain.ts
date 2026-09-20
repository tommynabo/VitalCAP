/**
 * Normalize a website URL down to its bare registrable-ish host for dedup
 * matching (Prompt 1 §1.3). Strips protocol, `www.`, path/query/fragment.
 * Returns `null` for input that isn't a plausible domain.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;

  let value = input.trim().toLowerCase();
  if (!value) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/^www\./, "");
  value = value.replace(/:\d+$/, "");
  value = value.replace(/\.$/, "");

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    return null;
  }

  return value;
}
