import type { VerificationStatus } from "@/domain/contacts/types";
import { createVerificationAcceptancePolicy, isContactPointAcceptable } from "./acceptance-policy";

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

  const status = input.verificationStatus ?? "unverified";
  if (isContactPointAcceptable(status, createVerificationAcceptancePolicy(input.allowCatchAll ?? false))) {
    return { eligible: true, reason: "eligible" };
  }

  switch (status) {
    case "valid":
    case "catch_all":
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