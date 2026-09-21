import { describe, expect, it } from "vitest";
import { validateSetterOutput } from "./setter-output-schema";

function validOutput() {
  return {
    language: "es",
    branch: "INTEREST",
    intentSummary: "Lead wants more info",
    confidence: 0.8,
    draft: "Hola, gracias por su interés...",
    needsHuman: true,
    reasonForHuman: null,
    detectedFactsRequested: [],
    riskFlags: [],
    suggestedNextAction: "Send product info",
  };
}

describe("validateSetterOutput", () => {
  it("accepts a well-formed output", () => {
    const result = validateSetterOutput(validOutput());
    expect(result.success).toBe(true);
    expect(result.data?.branch).toBe("INTEREST");
  });

  it("rejects an unknown branch value", () => {
    const result = validateSetterOutput({ ...validOutput(), branch: "NOT_A_REAL_BRANCH" });
    expect(result.success).toBe(false);
    expect(result.errorSummary).toContain("branch");
  });

  it("rejects a confidence value outside [0, 1]", () => {
    const result = validateSetterOutput({ ...validOutput(), confidence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { draft: _draft, ...rest } = validOutput();
    const result = validateSetterOutput(rest);
    expect(result.success).toBe(false);
  });
});
