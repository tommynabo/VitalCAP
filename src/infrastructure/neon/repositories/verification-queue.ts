import { getDb, schema } from "@/infrastructure/neon/db";
import { sql } from "drizzle-orm";

export async function enqueueVerificationJob(params: {
  workspaceId: string;
  contactPointId: string;
  provider: string;
}) {
  const db = getDb();
  
  await db.insert(schema.verificationJobs)
    .values({
      workspaceId: params.workspaceId,
      contactPointId: params.contactPointId,
      provider: params.provider,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        schema.verificationJobs.contactPointId,
        schema.verificationJobs.provider,
      ],
      where: sql`status IN ('pending', 'processing')`,
    });
}
