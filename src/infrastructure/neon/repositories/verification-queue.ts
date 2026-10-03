import { getDb, schema } from "@/infrastructure/neon/db";
import { createVerificationIdempotencyKey } from "@/domain/providers/email-verification-idempotency";

export async function enqueueVerificationJob(params: {
  workspaceId: string;
  contactPointId: string;
  normalizedEmail: string;
  provider: string;
}) {
  const db = getDb();
  const normalizedEmail = params.normalizedEmail.trim().toLowerCase();
  
  const [job] = await db.insert(schema.verificationJobs)
    .values({
      workspaceId: params.workspaceId,
      contactPointId: params.contactPointId,
      provider: params.provider,
      normalizedEmail,
      idempotencyKey: createVerificationIdempotencyKey({ ...params, normalizedEmail }),
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: schema.verificationJobs.id });
  return Boolean(job);
}
