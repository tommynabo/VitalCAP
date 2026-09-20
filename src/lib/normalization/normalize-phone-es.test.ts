import { describe, expect, it } from "vitest";
import { normalizePhoneES } from "./normalize-phone-es";

describe("normalizePhoneES", () => {
  it("accepts a bare 9-digit mobile number", () => {
    expect(normalizePhoneES("612345678")).toBe("+34612345678");
  });

  it("accepts +34 prefix with separators", () => {
    expect(normalizePhoneES("+34 612 345 678")).toBe("+34612345678");
  });

  it("accepts 0034 prefix", () => {
    expect(normalizePhoneES("0034612345678")).toBe("+34612345678");
  });

  it("accepts a landline starting with 9", () => {
    expect(normalizePhoneES("954 11 22 33")).toBe("+34954112233");
  });

  it("rejects non-Spanish or malformed numbers", () => {
    expect(normalizePhoneES("+1 415 555 0100")).toBeNull();
    expect(normalizePhoneES("12345")).toBeNull();
    expect(normalizePhoneES(null)).toBeNull();
  });
});
