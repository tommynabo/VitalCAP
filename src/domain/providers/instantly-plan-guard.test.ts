import { describe, expect, it } from "vitest";
import { evaluateInstantlyContactQuota } from "./instantly-plan-guard";

describe("evaluateInstantlyContactQuota", () => {
  it("warns at the configured threshold and permits imports below the hard limit", () => {
    expect(evaluateInstantlyContactQuota({
      uploadedContacts: 900,
      providerLimit: 5000,
      configuredHardLimit: 1000,
      warningThreshold: 900,
    })).toEqual({ allowed: true, hardLimit: 1000, remaining: 100, warning: true });
  });

  it("stops at the stricter of the provider and Growth plan limits", () => {
    expect(evaluateInstantlyContactQuota({
      uploadedContacts: 900,
      providerLimit: 900,
      configuredHardLimit: 1000,
      warningThreshold: 900,
    })).toEqual({ allowed: false, hardLimit: 900, remaining: 0, warning: true });
  });
});