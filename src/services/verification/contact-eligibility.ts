import type { VerificationStatus } from "@/domain/contacts/types";

export type ContactEligibilityReason =
  | "eligible"
  | "no_email"
  | "unverified"
  | "invalid"
  | "risky"
  | "suppressed"
  | "compliance_blocked";

export interface ContactEligibilityInput {
  hasEmail: boolean;
  verificationStatus?: VerificationStatus;
  isSuppressed?: boolean;
  complianceAllowed?: boolean;
  allowCatchAll?: boolean;
}

export interface ContactEligibility {
  eligible: boolean;
  reason: ContactEligibilityReason;
}

export function evaluateContactEligibility(input: ContactEligibilityInput): ContactEligibility {
  if (!input.hasEmail) return { eligible: false, reason: "no_email" };
  if (input.isSuppressed) return { eligible: false, reason: "suppressed" };
  if (input.complianceAllowed === false) return { eligible: false, reason: "compliance_blocked" };

  switch (input.verificationStatus ?? "unverified") {
    case "valid":
      return { eligible: true, reason: "eligible" };
    case "catch_all":
      return input.allowCatchAll
        ? { eligible: true, reason: "eligible" }
        : { eligible: false, reason: "risky" };
    case "risky":
      return { eligible: false, reason: "risky" };
    case "invalid":
    case "disposable":
    case "bounced":
      return { eligible: false, reason: "invalid" };
    case "unknown":
    case "unverified":
      return { eligible: false, reason: "unverified" };
  }
}