import { describe, expect, it } from "vitest";
import type { SuppressionEntry } from "@/domain/outreach/types";
import { addSuppression, checkSuppression } from "./suppression-service";

function entry(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
  return {
    id: "sup_1",
    workspaceId: "ws_demo",
    contactPointId: "cp_1",
    accountId: null,
    reason: "unsubscribe",
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("checkSuppression", () => {
  it("finds a match by contactPointId", () => {
    const result = checkSuppression({ contactPointId: "cp_1", accountId: null }, [entry()]);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("unsubscribe");
  });

  it("finds a match by accountId (account-level do-not-contact)", () => {
    const result = checkSuppression(
      { contactPointId: "cp_other", accountId: "acc_1" },
      [entry({ contactPointId: null, accountId: "acc_1", reason: "account_do_not_contact" })],
    );
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("account_do_not_contact");
  });

  it("returns not-suppressed when nothing matches", () => {
    const result = checkSuppression({ contactPointId: "cp_2", accountId: "acc_2" }, [entry()]);
    expect(result.suppressed).toBe(false);
    expect(result.entry).toBeNull();
  });
});

describe("addSuppression", () => {
  it("appends a new suppression entry", () => {
    const result = addSuppression([], {
      workspaceId: "ws_demo",
      contactPointId: "cp_1",
      accountId: null,
      reason: "permanent_bounce",
      now: new Date("2025-01-01T00:00:00Z"),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("permanent_bounce");
  });

  it("is idempotent: adding the same contact-point/reason twice does not duplicate", () => {
    const first = addSuppression([], {
      workspaceId: "ws_demo",
      contactPointId: "cp_1",
      accountId: null,
      reason: "unsubscribe",
      now: new Date("2025-01-01T00:00:00Z"),
    });
    const second = addSuppression(first, {
      workspaceId: "ws_demo",
      contactPointId: "cp_1",
      accountId: null,
      reason: "unsubscribe",
      now: new Date("2025-01-02T00:00:00Z"),
    });
    expect(second).toHaveLength(1);
  });
});
