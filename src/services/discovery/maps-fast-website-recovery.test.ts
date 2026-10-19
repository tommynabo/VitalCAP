import { describe, expect, it } from "vitest";
import type { MapsPlaceResult, SerpResult } from "@/domain/providers/types";
import { buildMapsFastWebsiteRecoveryQuery, selectMapsFastRecoveredWebsite } from "./maps-fast-website-recovery";

const place: MapsPlaceResult = {
  externalPlaceId: "place-1",
  name: "Farmacia Ejemplo",
  category: "farmacia",
  address: "Calle Mayor 1",
  postalCode: "28001",
  province: "Madrid",
  city: "Madrid",
  countryCode: "ES",
  websiteUrl: null,
  phone: "+34 911 111 111",
  latitude: null,
  longitude: null,
  rating: null,
  reviewCount: null,
  sourceUrl: null,
};

function result(overrides: Partial<SerpResult> = {}): SerpResult {
  return {
    title: "Farmacia Ejemplo Madrid | Oficial",
    url: "https://farmacia-ejemplo.es/contacto",
    snippet: "Farmacia Ejemplo en Madrid. Teléfono 911111111.",
    domain: "farmacia-ejemplo.es",
    ...overrides,
  };
}

describe("Maps Fast website recovery", () => {
  it("builds one identity-bound query from business name and locality", () => {
    expect(buildMapsFastWebsiteRecoveryQuery(place)).toBe('"Farmacia Ejemplo" Madrid');
  });

  it("rejects a result without matching business identity evidence", () => {
    expect(selectMapsFastRecoveredWebsite(place, [result({ title: "Farmacia Central Madrid", snippet: "Farmacia en Madrid" })])).toBeNull();
  });

  it.each([
    "https://www.facebook.com/farmaciaejemplo",
    "https://paginasamarillas.es/farmacia-ejemplo",
    "https://google.com/maps/place/farmacia-ejemplo",
  ])("rejects directory, social, and map hosts: %s", (url) => {
    expect(selectMapsFastRecoveredWebsite(place, [result({ url, domain: new URL(url).hostname })])).toBeNull();
  });

  it("selects a unique identity- and locality-matched business domain", () => {
    const recovered = selectMapsFastRecoveredWebsite(place, [
      result({ title: "Farmacia Ejemplo Madrid", url: "https://farmacia-ejemplo.es/contacto" }),
      result({
        title: "Farmacia Ejemplo Madrid",
        url: "https://farmacia-ejemplo.net/contacto",
        domain: "farmacia-ejemplo.net",
        snippet: "Farmacia Ejemplo en Madrid.",
      }),
    ]);

    expect(recovered).toMatchObject({
      domain: "farmacia-ejemplo.es",
      websiteUrl: "https://farmacia-ejemplo.es/",
    });
  });

  it("does not choose arbitrarily between equally supported domains", () => {
    const results = [
      result({ url: "https://farmacia-ejemplo.es/", domain: "farmacia-ejemplo.es" }),
      result({ url: "https://farmacia-ejemplo.com/", domain: "farmacia-ejemplo.com" }),
    ];

    expect(selectMapsFastRecoveredWebsite(place, results)).toBeNull();
  });

  it("requires enough public identity to construct a safe query", () => {
    expect(buildMapsFastWebsiteRecoveryQuery({ ...place, name: "Farmacia", city: null, province: null, phone: null })).toBeNull();
  });
});