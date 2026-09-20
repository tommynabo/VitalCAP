import { describe, expect, it } from "vitest";
import { computeStrategicPriority, verificationConfidence } from "./contact-priority";

describe("computeStrategicPriority", () => {
  it("scores a named owner/titular contact highest", () => {
    expect(computeStrategicPriority({ roleType: "owner", isPersonalOrNamed: true, isGeneric: false }).strategicPriority).toBe(100);
    expect(
      computeStrategicPriority({ roleType: "titular_pharmacist", isPersonalOrNamed: true, isGeneric: false }).strategicPriority,
    ).toBe(100);
  });

  it("ranks named purchasing manager above named manager above other named professionals", () => {
    const purchasing = computeStrategicPriority({ roleType: "purchasing_manager", isPersonalOrNamed: true, isGeneric: false });
    const manager = computeStrategicPriority({ roleType: "manager", isPersonalOrNamed: true, isGeneric: false });
    const other = computeStrategicPriority({ roleType: "employee", isPersonalOrNamed: true, isGeneric: false });
    expect(purchasing.strategicPriority).toBeGreaterThan(manager.strategicPriority);
    expect(manager.strategicPriority).toBeGreaterThan(other.strategicPriority);
  });

  it("scores generic role-labeled emails between named contacts and info@", () => {
    const compras = computeStrategicPriority({ roleType: "unknown", isPersonalOrNamed: false, isGeneric: true, label: "compras" });
    const gerencia = computeStrategicPriority({ roleType: "unknown", isPersonalOrNamed: false, isGeneric: true, label: "gerencia" });
    const info = computeStrategicPriority({ roleType: "unknown", isPersonalOrNamed: false, isGeneric: true, label: "info" });
    expect(compras.strategicPriority).toBeGreaterThan(gerencia.strategicPriority);
    expect(gerencia.strategicPriority).toBeGreaterThan(info.strategicPriority);
  });

  it("scores info@ above an unlabeled generic fallback", () => {
    const info = computeStrategicPriority({ roleType: "unknown", isPersonalOrNamed: false, isGeneric: true, label: "info" });
    const other = computeStrategicPriority({ roleType: "unknown", isPersonalOrNamed: false, isGeneric: true, label: "sales" });
    expect(info.strategicPriority).toBeGreaterThan(other.strategicPriority);
  });
});

describe("verificationConfidence", () => {
  it("keeps verification confidence independent from strategic priority", () => {
    // A high-priority owner email can still be technically risky...
    expect(verificationConfidence("risky")).toBeLessThan(verificationConfidence("valid"));
    // ...while a generic info@ can be technically valid.
    expect(verificationConfidence("valid")).toBe(1);
  });
});
