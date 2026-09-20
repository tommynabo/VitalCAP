import type { RoleType, VerificationStatus } from "@/domain/contacts/types";

export interface ContactPriorityInput {
  roleType: RoleType;
  isPersonalOrNamed: boolean;
  isGeneric: boolean;
  /** Local-part-derived label, e.g. "compras", "gerencia", "info". */
  label?: string | null;
}

export interface ContactPriorityResult {
  strategicPriority: number;
  basis: string;
}

const PURCHASING_LABELS = ["compras", "purchasing", "pedidos"];
const MANAGEMENT_LABELS = ["gerencia", "direccion", "dirección"];
const BUSINESS_SPECIFIC_LABELS = ["contacto", "tienda", "farmacia", "atencion", "atención"];

/**
 * Strategic priority only (Prompt 1 §1.5) — deliberately independent of
 * verification confidence (`verificationConfidence` below). A high-priority
 * owner email can be technically risky; a generic `info@` can be valid.
 * Routing (Phase 3) decides how to combine the two, not this module.
 */
export function computeStrategicPriority(input: ContactPriorityInput): ContactPriorityResult {
  const label = input.label?.trim().toLowerCase() ?? null;

  if (input.isPersonalOrNamed) {
    if (input.roleType === "owner" || input.roleType === "titular_pharmacist") {
      return { strategicPriority: 100, basis: "verified owner/titular named contact" };
    }
    if (input.roleType === "purchasing_manager") {
      return { strategicPriority: 95, basis: "named purchasing manager" };
    }
    if (input.roleType === "manager") {
      return { strategicPriority: 90, basis: "named manager" };
    }
    return { strategicPriority: 85, basis: "other named professional contact" };
  }

  if (label && PURCHASING_LABELS.includes(label)) {
    return { strategicPriority: 80, basis: `purchasing role label "${label}"` };
  }
  if (label && MANAGEMENT_LABELS.includes(label)) {
    return { strategicPriority: 75, basis: `management role label "${label}"` };
  }
  if (input.isGeneric && label && BUSINESS_SPECIFIC_LABELS.includes(label)) {
    return { strategicPriority: 65, basis: `business-specific generic label "${label}"` };
  }
  if (label === "info") {
    return { strategicPriority: 60, basis: "generic info@ contact" };
  }

  return { strategicPriority: 50, basis: "other generic contact" };
}

const VERIFICATION_CONFIDENCE: Record<VerificationStatus, number> = {
  valid: 1,
  catch_all: 0.6,
  unverified: 0.4,
  unknown: 0.2,
  risky: 0.3,
  disposable: 0.05,
  invalid: 0,
  bounced: 0,
};

/** Verification confidence only — the second, deliberately separate dimension from strategic priority. */
export function verificationConfidence(status: VerificationStatus): number {
  return VERIFICATION_CONFIDENCE[status];
}
