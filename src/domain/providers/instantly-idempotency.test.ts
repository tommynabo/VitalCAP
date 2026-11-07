import { describe, expect, it } from "vitest";
import { createInstantlyImportIdempotencyKey } from "./instantly-idempotency";

describe("createInstantlyImportIdempotencyKey", () => {
  const identity = {
    workspaceId: "workspace-1",
    accountId: "account-1",
    contactPointId: "contact-1",
    providerCampaignId: "campaign-1",
  };

  it("is stable for a workspace/account across contacts and external campaigns", () => {
    expect(createInstantlyImportIdempotencyKey(identity)).toBe(createInstantlyImportIdempotencyKey(identity));
    expect(createInstantlyImportIdempotencyKey({ ...identity, contactPointId: "contact-2", providerCampaignId: "campaign-2" }))
      .toBe(createInstantlyImportIdempotencyKey(identity));
  });

  it("changes when the workspace or account changes", () => {
    expect(createInstantlyImportIdempotencyKey({ ...identity, accountId: "account-2" })).not.toBe(createInstantlyImportIdempotencyKey(identity));
    expect(createInstantlyImportIdempotencyKey({ ...identity, workspaceId: "workspace-2" })).not.toBe(createInstantlyImportIdempotencyKey(identity));
  });
});