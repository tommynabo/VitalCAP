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
  ] as const)("classifies %s only in its declared niche", (name, niche, expected) => {
    const type = classifyNicheBusinessType(name, niche);
    expect(type).toBe(expected);
    expect(isAcceptedNicheBusinessType(type, niche)).toBe(true);
  });

  it.each([
    ["Spa Madrid"],
    ["Day spa centro urbano"],
    ["Wellness centre"],
    ["Centro de bienestar"],
    ["Centro de masajes y bienestar"],
  ])("accepts wellness ICP evidence: %s", (evidence) => {
    expect(classifyNicheBusinessType(evidence, "spas_wellness")).toBe("spa_wellness_center");
  });

  it.each([
    ["Hotel general con spa"],
    ["Resort wellness"],
    ["Salón de belleza con masajes"],
    ["Centro de estética"],
    ["Masajes a domicilio"],
  ])("rejects non-wellness evidence: %s", (evidence) => {
    expect(classifyNicheBusinessType(evidence, "spas_wellness")).toBe("other_retail");
  });

  it.each([
    ["Gimnasio boutique"],
    ["Centro de entrenamiento funcional"],
    ["Strength and conditioning center"],
    ["Centro de fuerza y acondicionamiento"],
    ["Independent small-medium gym"],
  ])("accepts premium fitness ICP evidence: %s", (evidence) => {
    expect(classifyNicheBusinessType(evidence, "premium_fitness")).toBe("premium_fitness_center");
  });

  it.each([
    ["Gimnasio low-cost"],
    ["Gimnasio municipal"],
    ["Gimnasio público"],
    ["Alquiler de instalaciones de fuerza"],
    ["Centro deportivo general"],
    ["Boutique de ropa premium"],
    ["Hotel premium"],
  ])("rejects non-premium fitness evidence: %s", (evidence) => {
    expect(classifyNicheBusinessType(evidence, "premium_fitness")).toBe("other_retail");
  });

  it.each([
    ["Personal training studio"],
    ["Estudio de entrenamiento personal"],
    ["Centro de entrenador personal"],
    ["Centro pequeño de personal training"],
    ["Entrenamiento personal en estudio de fuerza"],
    ["Centro boutique con entrenamiento personal y opción online"],
  ])("accepts personal training ICP evidence: %s", (evidence) => {
    expect(classifyNicheBusinessType(evidence, "personal_training")).toBe("personal_training_studio");
  });

  it.each([
    ["Entrenador personal online"],
    ["Entrenador personal a domicilio"],
    ["Personal trainer en casa"],
    ["Personal trainer freelance"],
    ["Entrenador personal en gimnasio de terceros"],
  ])("rejects non-studio personal training evidence: %s", (evidence) => {
    expect(classifyNicheBusinessType(evidence, "personal_training")).toBe("other_retail");
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

  it.each([
    ["yoga_pilates", "Yoga Pilates Studio"],
    ["spas_wellness", "Day Spa Wellness Centre"],
    ["premium_fitness", "Boutique Strength and Conditioning Gym"],
    ["personal_training", "Personal Training Studio"],
  ] as const)("keeps %s evidence within its own niche", (sourceNiche, evidence) => {
    const niches = ["yoga_pilates", "spas_wellness", "premium_fitness", "personal_training"] as const;
    for (const niche of niches) {
      const businessType = classifyNicheBusinessType(evidence, niche);
      expect(isAcceptedNicheBusinessType(businessType, niche)).toBe(niche === sourceNiche);
    }
  });

  it("keeps the existing pharmacy classifier independent of niche profiles", () => {
    expect(classifyBusinessType("Farmacia Central")).toBe("pharmacy");
    expect(isAcceptedIcpBusinessType("pharmacy")).toBe(true);
  });
});
