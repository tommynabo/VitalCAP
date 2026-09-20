import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./normalize-email";

describe("normalizeEmail", () => {
  it("lowercases a valid address", () => {
    expect(normalizeEmail("Marta.Delgado@Farmacia.example.ES")).toBe("marta.delgado@farmacia.example.es");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  info@example.es  ")).toBe("info@example.es");
  });

  it("rejects malformed addresses", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b..com")).toBeNull();
    expect(normalizeEmail("@example.es")).toBeNull();
  });

  it("returns null for empty/nullish input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});
