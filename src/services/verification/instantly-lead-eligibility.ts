import type { VerificationStatus } from "@/domain/contacts/types";

export type InstantlyEligibilityReason =
  | "eligible"
  | "no_email"
  | "verification_blocked"
  | "contact_not_eligible"
  | "compliance_blocked"
  | "suppressed"
  | "prior_cold_outreach"
  | "already_in_flight"
  | "already_in_campaign";

export interface InstantlyEligibilityInput {
  hasEmail: boolean;
  verificationStatus: VerificationStatus;
  contactEligibility: "eligible" | "unknown" | "blocked";
  complianceAllowed: boolean;
  isSuppressed: boolean;
  hasPriorColdOutreach: boolean;
  isInFlight: boolean;
  alreadyInCampaign: boolean;
}

export interface InstantlyEligibility {
  eligible: boolean;
  reason: InstantlyEligibilityReason;
}

export function evaluateInstantlyLeadEligibility(input: InstantlyEligibilityInput): InstantlyEligibility {
  if (!input.hasEmail) return { eligible: false, reason: "no_email" };
  if (input.isSuppressed) return { eligible: false, reason: "suppressed" };
  if (input.verificationStatus !== "valid") return { eligible: false, reason: "verification_blocked" };
  if (input.contactEligibility !== "eligible") return { eligible: false, reason: "contact_not_eligible" };
  if (!input.complianceAllowed) return { eligible: false, reason: "compliance_blocked" };
  if (input.hasPriorColdOutreach) return { eligible: false, reason: "prior_cold_outreach" };
  if (input.isInFlight) return { eligible: false, reason: "already_in_flight" };
  if (input.alreadyInCampaign) return { eligible: false, reason: "already_in_campaign" };
  return { eligible: true, reason: "eligible" };
}