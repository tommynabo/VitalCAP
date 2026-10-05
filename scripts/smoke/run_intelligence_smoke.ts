import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { getDb, schema } from "@/infrastructure/neon/db";
import { IntelligenceQueueProcessor } from "@/services/intelligence/queue-processor";
import { eq, sql } from "drizzle-orm";
import { getIntelligenceEnv } from "@/lib/config/env";
import { enqueueIntelligenceJob } from "@/infrastructure/neon/repositories/intelligence-queue";

async function main() {
  console.log("Starting Intelligence Smoke Test...");

  const env = getIntelligenceEnv();
  console.log("LLM_PROVIDER:", env.LLM_PROVIDER);
  console.log("PROSPECT_LLM_MODEL:", env.PROSPECT_LLM_MODEL);
  
  if (env.LLM_PROVIDER !== "openai" || !env.LLM_PROVIDER_API_KEY) {
    console.error("OpenAI is disabled or missing API key in environment variables. Aborting.");
    process.exit(1);
  }

  const db = getDb();
  
  // Find up to 3 qualified prospects that don't have a completed intelligence job
  const qualifiedMemberships = await db.execute(sql`
    SELECT cm.campaign_id, cm.account_id, c.workspace_id AS workspace_id
    FROM campaign_memberships cm
    JOIN campaigns c ON cm.campaign_id = c.id
    WHERE cm.stage = 'qualified'
      AND c.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM prospect_analyses pa
        WHERE pa.account_id = cm.account_id AND pa.status = 'completed'
      )
    LIMIT 3
  `);

  if (qualifiedMemberships.rows.length === 0) {
    console.log("No available qualified prospects to analyze.");
    process.exit(0);
  }

  console.log(`Found ${qualifiedMemberships.rows.length} prospects. Enqueueing jobs...`);

  for (const row of qualifiedMemberships.rows as any[]) {
    await enqueueIntelligenceJob({
      workspaceId: row.workspace_id,
      campaignId: row.campaign_id,
      accountId: row.account_id,
      idempotencyKey: `smoke-run-${Date.now()}`,
    });
    console.log(`Enqueued job for account ${row.account_id}`);
  }

  console.log("Running IntelligenceQueueProcessor...");
  const processor = new IntelligenceQueueProcessor();
  const processed = await processor.processBatch();
  
  console.log(`Processed ${processed} jobs.`);

  // Verify
  for (const row of qualifiedMemberships.rows as any[]) {
    const [analysis] = await db.select().from(schema.prospectAnalyses)
      .where(eq(schema.prospectAnalyses.accountId, row.account_id))
      .orderBy(sql`created_at DESC`)
      .limit(1);

    if (analysis) {
      console.log(`Account ${row.account_id} - Analysis Status: ${analysis.status}`);
      if (analysis.status === "completed") {
        console.log(`  Fit Score: ${analysis.fitScore}`);
        console.log(`  Fit Tier: ${analysis.fitTier}`);
        console.log(`  Estimated Cost: $${analysis.estimatedCostUsd}`);
        console.log(`  Tokens (total): ${analysis.totalTokens}`);
      } else if (analysis.status === "failed") {
        console.error(`  Error: ${analysis.error}`);
      }
    } else {
      console.error(`No analysis found for account ${row.account_id}`);
    }
  }

  console.log("Smoke test complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
