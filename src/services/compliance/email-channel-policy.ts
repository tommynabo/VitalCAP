import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { ChannelEligibilityStatus } from "@/domain/contacts/types";
import type { VerificationStatus } from "@/domain/contacts/types";
import { createVerificationAcceptancePolicy, isContactPointAcceptable } from "@/services/verification/acceptance-policy";

export type EmailChannelPolicyClassification = "eligible" | "review_required" | "blocked";
export type EmailComplianceDecision = "allowed" | "review_required" | "blocked";

export const VITALCAP_B2B_EMAIL_POLICY_VERSION = "v2.0.0";

export interface EmailChannelPolicyResult {
  eligible: boolean;
  requiresReview: boolean;
  blocked: boolean;
  normalizedStatus: ChannelEligibilityStatus;
  reasonCode: string;
}

export const EMAIL_CHANNEL_ELIGIBLE_STATUSES = [
  "professional_contact",
  "eligible_email",
  "consented_email",
  "prior_relationship",
] as const satisfies readonly ChannelEligibilityStatus[];

const EMAIL_CHANNEL_BLOCKED_STATUSES = ["opted_out", "blocked"] as const satisfies readonly ChannelEligibilityStatus[];

export interface EmailChannelEligibilityEvidence {
  existingStatus?: ChannelEligibilityStatus | null;
  explicitOptOut?: boolean;
  explicitBlock?: boolean;
  explicitConsent?: boolean;
  priorRelationship?: boolean;
  verifiedProfessionalContact?: boolean;
}

export function deriveEmailChannelEligibility(evidence: EmailChannelEligibilityEvidence = {}): ChannelEligibilityStatus {
  if (evidence.explicitOptOut) return "opted_out";
  if (evidence.explicitBlock) return "blocked";
  if (evidence.explicitConsent) return "consented_email";
  if (evidence.priorRelationship) return "prior_relationship";
  if (evidence.verifiedProfessionalContact) return "professional_contact";
  return evidence.existingStatus ?? "unknown";
}

export function classifyEmailChannelEligibility(
  status: ChannelEligibilityStatus | null | undefined,
): EmailChannelPolicyResult {
  const normalizedStatus = status ?? "unknown";

  if (EMAIL_CHANNEL_ELIGIBLE_STATUSES.includes(normalizedStatus as typeof EMAIL_CHANNEL_ELIGIBLE_STATUSES[number])) {
    return {
      eligible: true,
      requiresReview: false,
      blocked: false,
      normalizedStatus,
      reasonCode: "email_channel_eligible",
    };
  }

  if (EMAIL_CHANNEL_BLOCKED_STATUSES.includes(normalizedStatus as typeof EMAIL_CHANNEL_BLOCKED_STATUSES[number])) {
    return {
      eligible: false,
      requiresReview: false,
      blocked: true,
      normalizedStatus,
      reasonCode: normalizedStatus,
    };
  }

  return {
    eligible: false,
    requiresReview: true,
    blocked: false,
    normalizedStatus,
    reasonCode: "email_channel_review_required",
  };
}

export function isEmailChannelEligible(status: ChannelEligibilityStatus | null | undefined): boolean {
  return classifyEmailChannelEligibility(status).eligible;
}

export function evaluateB2BEmailCompliance(input: {
  channelEligibility: ChannelEligibilityStatus | null | undefined;
  verificationStatus: VerificationStatus | null | undefined;
  isSuppressed: boolean;
  allowCatchAll: boolean;
  policyApproved: boolean;
}): { decision: EmailComplianceDecision; reasonCode: string; reasonText: string } {
  if (input.isSuppressed) {
    return { decision: "blocked", reasonCode: "suppressed", reasonText: "An active suppression blocks email outreach." };
  }

  const channelPolicy = classifyEmailChannelEligibility(input.channelEligibility);
  if (channelPolicy.blocked) {
    return {
      decision: "blocked",
      reasonCode: channelPolicy.reasonCode,
      reasonText: `Email channel is blocked by status ${channelPolicy.normalizedStatus}.`,
    };
  }
  if (channelPolicy.requiresReview) {
    return {
      decision: "review_required",
      reasonCode: channelPolicy.reasonCode,
      reasonText: `Email channel status ${channelPolicy.normalizedStatus} requires review.`,
    };
  }

  const verificationStatus = input.verificationStatus ?? "unverified";
  const acceptancePolicy = createVerificationAcceptancePolicy(input.allowCatchAll);
  if (!isContactPointAcceptable(verificationStatus, acceptancePolicy)) {
    const blocked = verificationStatus === "invalid" || verificationStatus === "disposable" || verificationStatus === "bounced";
    return {
      decision: blocked ? "blocked" : "review_required",
      reasonCode: blocked ? `verification_${verificationStatus}` : `verification_${verificationStatus}`,
      reasonText: `Verification status ${verificationStatus} is not accepted for cold email.`,
    };
  }

  if (!input.policyApproved) {
    return {
      decision: "review_required",
      reasonCode: "b2b_email_policy_not_approved",
      reasonText: `Email passed channel and verification checks, but policy ${VITALCAP_B2B_EMAIL_POLICY_VERSION} is not approved for production.`,
    };
  }

  return {
    decision: "allowed",
    reasonCode: "approved_b2b_email_policy",
    reasonText: `Email passed the approved B2B email policy ${VITALCAP_B2B_EMAIL_POLICY_VERSION}.`,
  };
}

export function emailChannelEligibilitySql(column: SQLWrapper): SQL {
  const eligibleStatuses = sql.join(
    EMAIL_CHANNEL_ELIGIBLE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`${column} IN (${eligibleStatuses})`;
}