export interface EligibleContactPointCandidate {
  id: string;
  isPersonalOrNamed: boolean;
  isDecisionMaker: boolean;
  isGeneric: boolean;
  priorityScore: number;
  roleScore: number;
  verificationStatus: "valid" | "catch_all";
}

export function compareEligibleContactPoints(
  left: EligibleContactPointCandidate,
  right: EligibleContactPointCandidate,
): number {
  const decisionMakerDifference = Number(right.isDecisionMaker) - Number(left.isDecisionMaker);
  if (decisionMakerDifference !== 0) return decisionMakerDifference;

  const personalDifference = Number(right.isPersonalOrNamed) - Number(left.isPersonalOrNamed);
  if (personalDifference !== 0) return personalDifference;

  const roleDifference = left.roleScore - right.roleScore;
  if (roleDifference !== 0) return roleDifference;

  const genericDifference = Number(left.isGeneric) - Number(right.isGeneric);
  if (genericDifference !== 0) return genericDifference;

  const priorityDifference = right.priorityScore - left.priorityScore;
  if (priorityDifference !== 0) return priorityDifference;

  return Number(left.verificationStatus === "catch_all") - Number(right.verificationStatus === "catch_all");
}

export function selectPreferredContactPoint<T extends EligibleContactPointCandidate>(
  candidates: readonly T[],
): T | null {
  return [...candidates].sort(compareEligibleContactPoints)[0] ?? null;
}