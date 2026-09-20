import type { VerificationStatus } from "@/domain/contacts/types";

export interface VerificationAcceptancePolicy {
  acceptedStatuses: readonly VerificationStatus[];
}

/** Conservative default: only clearly-deliverable statuses are acceptable unless a campaign opts into more. */
export const DEFAULT_VERIFICATION_ACCEPTANCE_POLICY: VerificationAcceptancePolicy = {
  acceptedStatuses: ["valid", "catch_all"],
};

/**
 * Campaign-configurable acceptance check (Prompt 1 §1.6). Deliberately
 * contains no provider-specific assumptions — it only compares the
 * abstract `VerificationStatus` against the policy the campaign chose.
 */
export function isContactPointAcceptable(
  status: VerificationStatus,
  policy: VerificationAcceptancePolicy = DEFAULT_VERIFICATION_ACCEPTANCE_POLICY,
): boolean {
  return policy.acceptedStatuses.includes(status);
}
