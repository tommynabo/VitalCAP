/**
 * Best-effort Spanish phone type classification (Prompt 3 §3.5): "do not
 * assume every Maps phone is a mobile". This is a heuristic over the
 * national significant number's leading digit, not a telecom HLR lookup —
 * there is no such provider integrated in this phase, so anything that
 * doesn't match a well-known prefix pattern is reported `unknown` rather
 * than guessed. Channel eligibility is decided independently of this
 * (`ChannelEligibilityStatus`), never inferred from phone type alone.
 */

export type PhoneType = "mobile" | "landline" | "unknown";

export function classifyPhoneTypeES(normalizedE164: string | null): PhoneType {
  if (!normalizedE164) return "unknown";
  const match = /^\+34(\d)/.exec(normalizedE164);
  if (!match) return "unknown";
  const leadingDigit = match[1];
  if (leadingDigit === "6" || leadingDigit === "7") return "mobile";
  if (leadingDigit === "8" || leadingDigit === "9") return "landline";
  return "unknown";
}
