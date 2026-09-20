import { describe, expect, it } from "vitest";
import { normalizeBusinessName } from "./normalize-business-name";

describe("normalizeBusinessName", () => {
  it("lowercases and strips accents", () => {
    expect(normalizeBusinessName("Farmacia Núñez Peña")).toBe("farmacia nunez pena");
  });

  it("collapses punctuation and whitespace without dropping legal-form info", () => {
    expect(normalizeBusinessName("Farmacia  Delgado, S.L.")).toBe("farmacia delgado s l");
  });

  it("returns an empty string for empty/nullish input", () => {
    expect(normalizeBusinessName("")).toBe("");
    expect(normalizeBusinessName(null)).toBe("");
  });
});
