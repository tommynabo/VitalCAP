import { describe, expect, it } from "vitest";
import { sanitizeRecoveryJobError } from "./sanitize-recovery-error";

describe("sanitizeRecoveryJobError", () => {
  it("redacts stored secrets, URLs, seed terms, payloads, emails, and phones", () => {
    const rawError = "ZodError: failed query farmacias Madrid {\"DATABASE_URL\":\"postgres://db-user:db-pass@db.example/app\",\"APIFY_API_TOKEN\":\"apify_api_secret-value\",\"auth\":\"Bearer bearer-secret\",\"email\":\"person@example.com\",\"phone\":\"+1 555 123 4567\"}";
    const sanitized = sanitizeRecoveryJobError(rawError, ["farmacias", "Madrid"]);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.lastErrorClass).toBe("ZodError");
    expect(sanitized.lastFailureKind).toBe("configuration");
    expect(sanitized.lastErrorSafeMessage?.length).toBeLessThanOrEqual(300);
    expect(serialized).not.toContain("db-user");
    expect(serialized).not.toContain("db-pass");
    expect(serialized).not.toContain("apify_api_secret-value");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("farmacias");
    expect(serialized).not.toContain("Madrid");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("555 123 4567");
    expect(serialized).not.toContain("DATABASE_URL");
  });

  it("classifies known provider caps and never returns the raw stored message", () => {
    const rawError = "Provider reservation rejected: max daily requests exceeded for workspace workspace-secret";
    const sanitized = sanitizeRecoveryJobError(rawError);

    expect(sanitized.lastFailureKind).toBe("raw_request_cap");
    expect(JSON.stringify(sanitized)).not.toContain("workspace-secret");
  });

  it("returns null details when no error was stored", () => {
    expect(sanitizeRecoveryJobError(null)).toEqual({
      lastErrorClass: null,
      lastErrorSafeMessage: null,
      lastFailureKind: null,
    });
  });
});