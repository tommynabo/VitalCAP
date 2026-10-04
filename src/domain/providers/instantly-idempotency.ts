import { createHash } from "node:crypto";

export function createInstantlyImportIdempotencyKey(input: {
  workspaceId: string;
  accountId: string;
  contactPointId: string;
  providerCampaignId: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.workspaceId,
      input.accountId,
      input.contactPointId,
      input.providerCampaignId,
    ]))
    .digest("hex");
}