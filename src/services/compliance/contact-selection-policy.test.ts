import { describe, expect, it } from "vitest";
import { selectPreferredContactPoint, type EligibleContactPointCandidate } from "./contact-selection-policy";

describe("selectPreferredContactPoint", () => {
  it("chooses one named decision maker over a generic email for the same account", () => {
    const candidates: EligibleContactPointCandidate[] = [
      { id: "generic", isPersonalOrNamed: false, isDecisionMaker: false, isGeneric: true, priorityScore: 99, roleScore: 6, verificationStatus: "valid" },
      { id: "owner", isPersonalOrNamed: true, isDecisionMaker: true, isGeneric: false, priorityScore: 20, roleScore: 1, verificationStatus: "valid" },
    ];

    expect(selectPreferredContactPoint(candidates)?.id).toBe("owner");
    expect(selectPreferredContactPoint([])).toBeNull();
  });

  it("uses priority before verification result after role and endpoint signals", () => {
    const preferred = { id: "high-priority", isPersonalOrNamed: true, isDecisionMaker: false, isGeneric: false, priorityScore: 90, roleScore: 2, verificationStatus: "catch_all" } as const;
    const fallback = { ...preferred, id: "lower-priority", priorityScore: 10, verificationStatus: "valid" } as const;

    expect(selectPreferredContactPoint([fallback, preferred])?.id).toBe("high-priority");
  });

  it("prefers a relevant role-based endpoint over generic mailboxes", () => {
    const purchasing = { id: "purchasing", isPersonalOrNamed: false, isDecisionMaker: false, isGeneric: true, priorityScore: 50, roleScore: 2, verificationStatus: "valid" } as const;
    const generic = { ...purchasing, id: "generic", priorityScore: 99, roleScore: 99 } as const;

    expect(selectPreferredContactPoint([generic, purchasing])?.id).toBe("purchasing");
  });
});