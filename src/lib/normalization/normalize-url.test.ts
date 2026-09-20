import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./normalize-url";

describe("normalizeUrl", () => {
  it("adds a default scheme and strips www", () => {
    expect(normalizeUrl("www.example.es/contacto")).toBe("https://example.es/contacto");
  });

  it("strips tracking params but keeps meaningful ones, sorted", () => {
    expect(normalizeUrl("https://example.es/?b=2&utm_source=newsletter&a=1&fbclid=xyz")).toBe(
      "https://example.es/?a=1&b=2",
    );
  });

  it("strips default ports and trailing slash on non-root paths", () => {
    expect(normalizeUrl("https://example.es:443/contacto/")).toBe("https://example.es/contacto");
  });

  it("keeps a bare root path as /", () => {
    expect(normalizeUrl("https://example.es")).toBe("https://example.es/");
  });

  it("rejects non-http(s) schemes and invalid input", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
  });
});
