import { describe, expect, it } from "vitest";
import { classifyPhoneTypeES } from "./classify-phone-type-es";

describe("classifyPhoneTypeES", () => {
  it("classifies leading 6/7 as mobile", () => {
    expect(classifyPhoneTypeES("+34611222333")).toBe("mobile");
    expect(classifyPhoneTypeES("+34711222333")).toBe("mobile");
  });

  it("classifies leading 8/9 as landline", () => {
    expect(classifyPhoneTypeES("+34911222333")).toBe("landline");
    expect(classifyPhoneTypeES("+34811222333")).toBe("landline");
  });

  it("returns unknown for null or non-Spanish numbers", () => {
    expect(classifyPhoneTypeES(null)).toBe("unknown");
    expect(classifyPhoneTypeES("+1611222333")).toBe("unknown");
  });
});
