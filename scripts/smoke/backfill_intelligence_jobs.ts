import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { getDb, schema } from "@/infrastructure/neon/db";
import { sql } from "drizzle-orm";
import { enqueueIntelligenceJob } from "@/infrastructure/neon/repositories/intelligence-queue";

async function main() {
  console.log("Starting Intelligence Jobs Backfill...");
  const db = getDb();
  
  // Find all qualified prospects that don't have an intelligence job
  const qualifiedMemberships = await db.execute(sql`
    SELECT cm.campaign_id, cm.account_id, cm.workspace_id
    FROM campaign_memberships cm
    JOIN campaigns c ON cm.campaign_id = c.id
    WHERE cm.stage = 'qualified'
      AND c.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM intelligence_jobs ij
        WHERE ij.account_id = cm.account_id AND ij.campaign_id = cm.campaign_id
      )
  `);

  if (qualifiedMemberships.rows.length === 0) {
    console.log("No backfill needed.");
    process.exit(0);
  }

  console.log(`Found ${qualifiedMemberships.rows.length} prospects needing backfill. Enqueueing jobs...`);

  let count = 0;
  for (const row of qualifiedMemberships.rows as any[]) {
    await enqueueIntelligenceJob({
      workspaceId: row.workspace_id,
      campaignId: row.campaign_id,
      accountId: row.account_id,
      idempotencyKey: `backfill-${Date.now()}`,
    });
    count++;
    if (count % 100 === 0) {
      console.log(`Enqueued ${count} jobs...`);
    }
  }

  console.log(`Finished backfilling ${count} intelligence jobs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
