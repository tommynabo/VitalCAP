import { getDb, schema } from "@/infrastructure/neon/db";
import { sql } from "drizzle-orm";

export async function enqueueIntelligenceJob(params: {
  workspaceId: string;
  campaignId: string;
  accountId: string;
  idempotencyKey: string;
}) {
  const db = getDb();
  
  await db.insert(schema.intelligenceJobs)
    .values({
      workspaceId: params.workspaceId,
      campaignId: params.campaignId,
      accountId: params.accountId,
      payload: {},
      idempotencyKey: params.idempotencyKey,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        schema.intelligenceJobs.campaignId,
        schema.intelligenceJobs.accountId,
        schema.intelligenceJobs.idempotencyKey,
      ],
    });
}
