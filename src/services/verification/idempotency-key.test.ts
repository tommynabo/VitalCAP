import { describe, expect, it } from "vitest";
import { createVerificationIdempotencyKey } from "@/domain/providers/email-verification-idempotency";

const input = {
  workspaceId: "workspace-1",
  contactPointId: "contact-point-1",
  normalizedEmail: " Owner@Example.com ",
  provider: "millionverifier",
};

describe("createVerificationIdempotencyKey", () => {
  it("normalizes the email and is stable for the same workspace/contact/provider/version", () => {
    expect(createVerificationIdempotencyKey(input)).toBe(createVerificationIdempotencyKey({ ...input, normalizedEmail: "owner@example.com" }));
  });

  it.each([
    ["workspaceId", "workspace-2"],
    ["contactPointId", "contact-point-2"],
    ["provider", "other-provider"],
  ] as const)("changes when %s changes", (key, value) => {
    expect(createVerificationIdempotencyKey(input)).not.toBe(createVerificationIdempotencyKey({ ...input, [key]: value }));
  });
});