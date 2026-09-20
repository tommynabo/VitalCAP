import { describe, expect, it } from "vitest";
import { normalizeAddress } from "./normalize-address";

describe("normalizeAddress", () => {
  it("expands common street abbreviations", () => {
    expect(normalizeAddress("C/ Sierpes Nº 12")).toBe("calle sierpes numero 12");
  });

  it("expands Avda/Pza and strips accents", () => {
    expect(normalizeAddress("Avda. de la Constitución, Pza. Mayor")).toBe("avenida de la constitucion plaza mayor");
  });

  it("returns an empty string for empty/nullish input", () => {
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress(null)).toBe("");
  });
});
