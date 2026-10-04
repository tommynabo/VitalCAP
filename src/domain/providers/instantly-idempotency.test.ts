import { describe, expect, it } from "vitest";
import { createInstantlyImportIdempotencyKey } from "./instantly-idempotency";

describe("createInstantlyImportIdempotencyKey", () => {
  const identity = {
    workspaceId: "workspace-1",
    accountId: "account-1",
    contactPointId: "contact-1",
    providerCampaignId: "campaign-1",
  };

  it("is stable for the same workspace/account/contact/campaign", () => {
    expect(createInstantlyImportIdempotencyKey(identity)).toBe(createInstantlyImportIdempotencyKey(identity));
  });

  it("changes when any identity component changes", () => {
    expect(createInstantlyImportIdempotencyKey({ ...identity, accountId: "account-2" })).not.toBe(createInstantlyImportIdempotencyKey(identity));
    expect(createInstantlyImportIdempotencyKey({ ...identity, providerCampaignId: "campaign-2" })).not.toBe(createInstantlyImportIdempotencyKey(identity));
  });
});