/**
 * Compliance / channel eligibility contract (Prompt 0 §0.9). Discovering an
 * endpoint never implies permission to send to it — every send must pass
 * through a `ComplianceGate` that checks workspace config, suppression
 * status and campaign rules first. Implemented in Phase 3; this module only
 * fixes the interface so no other layer needs to guess its shape.
 */

import type { ChannelEligibilityStatus, ContactPointType } from "@/domain/contacts/types";

export interface ComplianceCheckInput {
  contactPointId: string;
  accountId: string;
  campaignId: string;
  channel: ContactPointType;
  currentEligibility: ChannelEligibilityStatus;
}

export interface ComplianceCheckResult {
  allowed: boolean;
  reason: string | null;
}

export interface ComplianceGate {
  check(input: ComplianceCheckInput): Promise<ComplianceCheckResult>;
}
