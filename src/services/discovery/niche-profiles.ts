export const NICHE_PROFILES = {
  yoga_pilates: {
    campaignName: "Yoga & Pilates",
    categoryTerms: ["estudio de yoga", "estudio de pilates", "centro de yoga y pilates", "yoga studio", "pilates studio"],
  },
  spas_wellness: {
    campaignName: "Spas & Wellness",
    categoryTerms: ["spa", "day spa", "centro wellness", "centro de bienestar", "centro de masajes y bienestar"],
  },
  premium_fitness: {
    campaignName: "Premium Gyms & Boutique Fitness",
    categoryTerms: ["gimnasio boutique", "entrenamiento funcional", "centro de entrenamiento premium", "estudio de fuerza y acondicionamiento"],
  },
  personal_training: {
    campaignName: "Personal Training Studios",
    categoryTerms: ["estudio de entrenamiento personal", "personal training studio", "entrenador personal con estudio", "centro de personal training"],
  },
} as const;

export type NicheId = keyof typeof NICHE_PROFILES;

export function getNicheId(value: unknown): NicheId | null {
  return typeof value === "string" && Object.hasOwn(NICHE_PROFILES, value)
    ? value as NicheId
    : null;
}

export function getNicheProfile(value: unknown) {
  const niche = getNicheId(value);
  return niche ? NICHE_PROFILES[niche] : null;
}