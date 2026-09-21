import type { ComplianceCheckInput, ComplianceCheckResult, ComplianceGate } from "@/domain/compliance/types";
import type { ChannelEligibilityStatus } from "@/domain/contacts/types";
import type { SuppressionEntry } from "@/domain/outreach/types";
import { checkSuppression } from "./suppression-service";

/**
 * `ComplianceGate` implementation (Prompt 0 §0.9, Prompt 3 §3.2/§3.7).
 * Suppression is checked first and always wins — no eligibility status can
 * override an explicit suppression entry. After that, eligibility is
 * evaluated per-channel: an email-eligible contact is not automatically
 * SMS-eligible and vice versa (channel eligibility ≠ endpoint existence).
 */

const EMAIL_ELIGIBLE: ReadonlySet<ChannelEligibilityStatus> = new Set([
  "professional_contact",
  "eligible_email",
  "consented_email",
  "prior_relationship",
]);

const SMS_ELIGIBLE: ReadonlySet<ChannelEligibilityStatus> = new Set(["eligible_sms", "consented_sms", "prior_relationship"]);

const ALWAYS_BLOCKED: ReadonlySet<ChannelEligibilityStatus> = new Set(["opted_out", "blocked"]);

export function evaluateChannelEligibility(channel: ComplianceCheckInput["channel"], status: ChannelEligibilityStatus): boolean {
  if (ALWAYS_BLOCKED.has(status)) return false;
  if (channel === "email") return EMAIL_ELIGIBLE.has(status);
  if (channel === "phone") return SMS_ELIGIBLE.has(status);
  // linkedin/other channels have no delivery provider implemented this phase — never eligible by default.
  return false;
}

export class SuppressionAwareComplianceGate implements ComplianceGate {
  constructor(private readonly suppressionEntries: () => readonly SuppressionEntry[]) {}

  async check(input: ComplianceCheckInput): Promise<ComplianceCheckResult> {
    const suppression = checkSuppression(
      { contactPointId: input.contactPointId, accountId: input.accountId },
      this.suppressionEntries(),
    );
    if (suppression.suppressed) {
      return { allowed: false, reason: `Suppressed: ${suppression.reason}` };
    }

    if (ALWAYS_BLOCKED.has(input.currentEligibility)) {
      return { allowed: false, reason: `Channel eligibility is "${input.currentEligibility}"` };
    }

    if (!evaluateChannelEligibility(input.channel, input.currentEligibility)) {
      return { allowed: false, reason: `Not eligible for channel "${input.channel}" (status: ${input.currentEligibility})` };
    }

    return { allowed: true, reason: null };
  }
}
