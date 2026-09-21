import type { SetterBranch, SetterDraft } from "@/domain/conversations/types";

/**
 * Progressive autonomy policy engine (Prompt 4 §4.9). Built and tested, but
 * structurally inert: `AUTO_SEND_ENABLED` is a hardcoded `false` and
 * nothing in `review-service.ts` / the (not-yet-built) setter orchestrator
 * imports or calls `canAutoSend`. Enabling autosend later requires a
 * deliberate, separately-reviewed change to actually invoke this function
 * from a send path — mirroring ADR-012's "structural safety over a runtime
 * flag" pattern for the dry-run outreach orchestrator.
 */
export const AUTO_SEND_ENABLED = false as const;

export interface AutonomyPolicyConfig {
  campaignAutoSendEnabled: boolean;
  branchAllowlist: readonly SetterBranch[];
  minimumConfidence: number;
  allowedContactTypes: readonly string[];
}

export interface AutonomyDecisionInput {
  draft: SetterDraft;
  contactType: string;
  policy: AutonomyPolicyConfig;
}

export interface AutonomyDecision {
  canAutoSend: boolean;
  blockedReasons: string[];
}

/**
 * Pure evaluator — never wired to an actual send action. Even if every
 * per-branch condition passes, the caller must still separately check
 * `AUTO_SEND_ENABLED` (this function does not read that global itself, so
 * unit tests can exercise the branch-level policy logic in isolation from
 * the global kill switch).
 */
export function canAutoSend(input: AutonomyDecisionInput): AutonomyDecision {
  const blockedReasons: string[] = [];

  if (!input.policy.campaignAutoSendEnabled) blockedReasons.push("campaign_does_not_permit_autosend");
  if (!input.policy.branchAllowlist.includes(input.draft.branch)) blockedReasons.push("branch_not_in_allowlist");
  if (input.draft.confidence < input.policy.minimumConfidence) blockedReasons.push("confidence_below_threshold");
  if (input.draft.riskFlags.length > 0) blockedReasons.push("risk_flags_present");
  if (input.draft.needsHuman) blockedReasons.push("draft_marked_needs_human");
  if (!input.policy.allowedContactTypes.includes(input.contactType)) blockedReasons.push("contact_type_not_permitted");

  return { canAutoSend: blockedReasons.length === 0, blockedReasons };
}
