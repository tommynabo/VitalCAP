import { describe, expect, it } from "vitest";
import { APIFY_MAPS_ACTOR_CANDIDATES, findActorCandidate } from "./actor-registry";

describe("actor-registry", () => {
  it("lists the candidates named in Prompt 7 §11", () => {
    const ids = APIFY_MAPS_ACTOR_CANDIDATES.map((c) => c.actorId);
    expect(ids).toEqual([
      "bovi/google-maps-scraper",
      "compass/crawler-google-places",
      "microworlds/crawler-google-places",
      "lukaskrivka/google-maps-with-contact-details",
    ]);
  });

  it("finds a candidate by actor ID", () => {
    expect(findActorCandidate("compass/crawler-google-places")?.role).toBe("maps_deep_primary");
    expect(findActorCandidate("nonexistent")).toBeUndefined();
  });
});
