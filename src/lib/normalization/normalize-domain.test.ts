import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./normalize-domain";

describe("normalizeDomain", () => {
  it("strips protocol and www", () => {
    expect(normalizeDomain("https://www.farmaciadelgado.example.es")).toBe("farmaciadelgado.example.es");
  });

  it("strips path, query and fragment", () => {
    expect(normalizeDomain("http://example.es/contacto?utm_source=x#top")).toBe("example.es");
  });

  it("strips a default-looking port", () => {
    expect(normalizeDomain("example.es:443")).toBe("example.es");
  });

  it("is case-insensitive", () => {
    expect(normalizeDomain("EXAMPLE.ES")).toBe("example.es");
  });

  it("returns null for empty/invalid input", () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
  });
});
