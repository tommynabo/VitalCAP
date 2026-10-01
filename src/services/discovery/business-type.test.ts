import { describe, expect, it } from "vitest";
import { classifyBusinessType, isAcceptedIcpBusinessType } from "./business-type";

describe("Vitalcap canonical ICP business classification", () => {
  it.each([
    ["Farmacia del Pueblo", "pharmacy"],
    ["Farmacia Independiente San Miguel", "pharmacy"],
    ["Parafarmacia Salud", "parapharmacy"],
    ["Herbolario La Encina", "herbal_shop"],
    ["Herbolaria Rural", "herbal_shop"],
  ] as const)("accepts %s", (name, expectedType) => {
    const type = classifyBusinessType(name);
    expect(type).toBe(expectedType);
    expect(isAcceptedIcpBusinessType(type)).toBe(true);
  });

  it.each([
    ["Suplementos Deportivos Pro", "supplement_store"],
    ["Nutrición Deportiva Elite", "sports_nutrition_store"],
    ["Tienda Fitness Centro", "other_retail"],
  ] as const)("rejects %s from the ICP", (name, expectedType) => {
    const type = classifyBusinessType(name);
    expect(type).toBe(expectedType);
    expect(isAcceptedIcpBusinessType(type)).toBe(false);
  });
});
