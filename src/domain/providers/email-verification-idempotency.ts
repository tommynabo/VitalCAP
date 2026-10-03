import { createHash } from "node:crypto";

export const EMAIL_VERIFICATION_PIPELINE_VERSION = "v1";

export function createVerificationIdempotencyKey(input: {
  workspaceId: string;
  contactPointId: string;
  normalizedEmail: string;
  provider: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.workspaceId,
      input.contactPointId,
      input.normalizedEmail.trim().toLowerCase(),
      input.provider,
      EMAIL_VERIFICATION_PIPELINE_VERSION,
    ]))
    .digest("hex");
}