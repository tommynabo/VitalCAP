/**
 * Apify Maps actor registry (Prompt 7 §11/§13) — cost-aware candidate list,
 * not one hardcoded actor. `npm run benchmark:maps` (see
 * `scripts/benchmark-maps.ts`) measures realized cost/usable-account across
 * these candidates before any of them becomes the default for a given
 * engine; this module only names the candidates and their intended role,
 * it never picks a "winner" itself.
 */

export type ApifyMapsActorRole = "maps_fast_candidate" | "maps_deep_primary" | "maps_fallback" | "deep_contact_enrichment";

export interface ApifyMapsActorCandidate {
  /** Apify actor ID in `owner/name` form, as used in the REST API path. */
  actorId: string;
  role: ApifyMapsActorRole;
  label: string;
  notes: string;
}

export const APIFY_MAPS_ACTOR_CANDIDATES: readonly ApifyMapsActorCandidate[] = [
  {
    actorId: "bovi/google-maps-scraper",
    role: "maps_fast_candidate",
    label: "Candidate A — cheap Maps Fast",
    notes: "Use only if a real smoke test proves stable output, good Spain coverage, enough identity/contact fields, low failure rate.",
  },
  {
    actorId: "compass/crawler-google-places",
    role: "maps_deep_primary",
    label: "Candidate B — reliable primary/fallback",
    notes:
      "Base scraping by default; social scraping off and maximumLeadsEnrichmentRecords=0 unless a campaign explicitly needs paid enrichment.",
  },
  {
    actorId: "microworlds/crawler-google-places",
    role: "maps_fast_candidate",
    label: "Candidate C — email-inclusive alternative",
    notes: "Benchmark rather than assume it is better than Candidate A/B.",
  },
  {
    actorId: "lukaskrivka/google-maps-with-contact-details",
    role: "deep_contact_enrichment",
    label: "Optional deep-contact fallback",
    notes:
      "Do NOT run on every Maps lead. Only when: account is high-fit, own website/email extraction failed, campaign is Maps Deep, and cost policy allows it.",
  },
] as const;

export function findActorCandidate(actorId: string): ApifyMapsActorCandidate | undefined {
  return APIFY_MAPS_ACTOR_CANDIDATES.find((c) => c.actorId === actorId);
}
