import { describe, expect, it } from "vitest";
import { normalizeLinkedInUrl } from "./normalize-linkedin-url";

describe("normalizeLinkedInUrl", () => {
  it("canonicalizes a personal profile URL", () => {
    expect(normalizeLinkedInUrl("https://es.linkedin.com/in/marta-delgado-33a/?originalSubdomain=es")).toBe(
      "https://www.linkedin.com/in/marta-delgado-33a",
    );
  });

  it("canonicalizes a company URL", () => {
    expect(normalizeLinkedInUrl("http://www.linkedin.com/company/farmacia-delgado/")).toBe(
      "https://www.linkedin.com/company/farmacia-delgado",
    );
  });

  it("rejects non-LinkedIn URLs and non-profile paths", () => {
    expect(normalizeLinkedInUrl("https://www.facebook.com/in/marta")).toBeNull();
    expect(normalizeLinkedInUrl("https://www.linkedin.com/feed/")).toBeNull();
    expect(normalizeLinkedInUrl(null)).toBeNull();
  });
});
