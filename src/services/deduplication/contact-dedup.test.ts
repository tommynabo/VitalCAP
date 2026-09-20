import { describe, expect, it } from "vitest";
import { evaluateContactDedup, type ContactIdentitySignals } from "./contact-dedup";

const owner: ContactIdentitySignals = {
  contactId: "ct_owner",
  accountId: "acc_1",
  normalizedFullName: "marta delgado",
  normalizedEmail: "marta@farmaciadelgado.example.es",
};

describe("evaluateContactDedup", () => {
  it("merges on exact normalized email at the same account", () => {
    const decision = evaluateContactDedup(
      { accountId: "acc_1", normalizedFullName: null, normalizedEmail: "marta@farmaciadelgado.example.es" },
      [owner],
    );
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.signal).toBe("normalized_email");
  });

  it("merges on exact full name at the same account when no endpoint overlaps", () => {
    const decision = evaluateContactDedup(
      { accountId: "acc_1", normalizedFullName: "marta delgado", normalizedEmail: "marta.delgado@personal.example" },
      [owner],
    );
    expect(decision.action).toBe("merge");
    expect(decision.matches[0]?.signal).toBe("full_name_account");
  });

  it("allows multiple distinct named contacts on the same account (no false merge)", () => {
    const manager: ContactIdentitySignals = {
      contactId: "ct_manager",
      accountId: "acc_1",
      normalizedFullName: "naia etxebarria",
      normalizedEmail: "naia@farmaciadelgado.example.es",
    };
    const decision = evaluateContactDedup(
      { accountId: "acc_1", normalizedFullName: "iker zabala", normalizedEmail: "iker@farmaciadelgado.example.es" },
      [owner, manager],
    );
    expect(decision.action).toBe("no_match");
  });

  it("never matches the same email across a different account", () => {
    const decision = evaluateContactDedup(
      { accountId: "acc_2", normalizedFullName: "marta delgado", normalizedEmail: "marta@farmaciadelgado.example.es" },
      [owner],
    );
    expect(decision.action).toBe("no_match");
  });
});
