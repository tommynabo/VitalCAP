import { describe, expect, it } from "vitest";
import { classifyBusinessType, classifyNicheBusinessType, isAcceptedIcpBusinessType, isAcceptedNicheBusinessType } from "./business-type";

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

describe("niche-specific business classification", () => {
  it.each([
    ["Estudio Yoga Norte", "yoga_pilates", "yoga_pilates_studio"],
    ["Pilates Studio Centro", "yoga_pilates", "yoga_pilates_studio"],
    ["Spa Wellness Madrid", "spas_wellness", "spa_wellness_center"],
    ["Boutique de entrenamiento funcional", "premium_fitness", "premium_fitness_center"],
    ["Estudio de entrenamiento personal", "personal_training", "personal_training_studio"],
  ] as const)("classifies %s only in its declared niche", (name, niche, expected) => {
    const type = classifyNicheBusinessType(name, niche);
    expect(type).toBe(expected);
    expect(isAcceptedNicheBusinessType(type, niche)).toBe(true);
  });

  it.each([
    ["Gimnasio municipal con yoga", "yoga_pilates"],
    ["Hotel general con wellness", "spas_wellness"],
    ["Gimnasio low-cost", "premium_fitness"],
    ["Entrenador personal online", "personal_training"],
    ["Entrenador personal freelance", "personal_training"],
  ] as const)("rejects excluded profile %s", (name, niche) => {
    expect(classifyNicheBusinessType(name, niche)).toBe("other_retail");
  });

  it("keeps the existing pharmacy classifier independent of niche profiles", () => {
    expect(classifyBusinessType("Farmacia Central")).toBe("pharmacy");
    expect(isAcceptedIcpBusinessType("pharmacy")).toBe(true);
  });
});
