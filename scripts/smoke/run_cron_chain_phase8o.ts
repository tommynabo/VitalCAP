import { getDb } from "../../src/infrastructure/neon/db";
import { sql } from "drizzle-orm";
import { getMapsEnv } from "../../src/lib/config/env";
import { runWatchdogCronTick } from "../../src/infrastructure/jobs/runners/watchdog-runner";
import { runProviderRunsCronCheck } from "../../src/infrastructure/jobs/runners/provider-runs-runner";
import { runAutopilotCronTick } from "../../src/infrastructure/jobs/runners/autopilot-runner";
import { getAutopilotPacingState } from "../../src/infrastructure/neon/repositories/autopilot";

async function main() {
  console.log("=== Phase 8O: Watchdog & Autopilot Reliability Run ===");

  const db = getDb();
  
  const workspaces = await db.execute(sql`SELECT id FROM workspaces LIMIT 1`);
  const workspaceId = workspaces.rows[0]?.id as string | undefined;

  if (!workspaceId) {
    console.error("No workspace found. Cannot run test.");
    process.exit(1);
  }

  // 1. Force a corrupted state for watchdog to fix
  console.log("\n[1] Seeding corrupt data for watchdog test...");
  
  const fakeCampaigns = await db.execute(sql`SELECT id FROM campaigns WHERE workspace_id = ${workspaceId} LIMIT 1`);
  const fakeCampaign = fakeCampaigns.rows[0] as { id: string } | undefined;
  if (!fakeCampaign) {
    console.error("No campaign found. Setup Phase 8M first.");
    process.exit(1);
  }
  const campaignId = fakeCampaign.id;

  await db.execute(sql`
    INSERT INTO discovery_jobs (campaign_id, type, status, attempt_count, max_attempts)
    VALUES (${campaignId}::uuid, 'dummy_test', 'pending', 6, 5)
  `);

  // 2. Run Watchdog
  console.log("\n[2] Running Watchdog Cron...");
  const watchdogResult = await runWatchdogCronTick();
  console.log("Watchdog Result:", watchdogResult);

  // 3. Run Provider Check
  console.log("\n[3] Running Provider Health/Cost Check...");
  const providerCheckResult = await runProviderRunsCronCheck();
  console.log("Provider Check Result:", providerCheckResult);

  // 4. Run Autopilot (pacing, target, rebalancing)
  console.log("\n[4] Running Autopilot Cron...");
  const autopilotResult = await runAutopilotCronTick();
  console.log("Autopilot Result:", {
    campaignsTicked: autopilotResult.campaignsTicked,
    pausedWorkspaces: autopilotResult.pausedWorkspaces,
    ordersScheduled: autopilotResult.ordersScheduled
  });

  // 5. Output Operational Snapshot (Cost Intelligence)
  console.log("\n[5] Operational Snapshot & Cost Intelligence...");
  const pacing = await getAutopilotPacingState(workspaceId);
  const apifySpend = pacing.apifySpendToday;
  const rawYield = pacing.rawReturnedToday;
  const qualified = pacing.targetAchievedToday;

  const costPerRaw = rawYield > 0 ? (apifySpend / rawYield).toFixed(3) : "N/A";
  const costPerQualified = qualified > 0 ? (apifySpend / qualified).toFixed(3) : "N/A";

  console.log(`- Apify Spend Today: $${apifySpend.toFixed(2)}`);
  console.log(`- Raw Candidates Today: ${rawYield}`);
  console.log(`- Qualified Today: ${qualified}`);
  console.log(`- Cost per Raw: $${costPerRaw}`);
  console.log(`- Cost per Qualified: $${costPerQualified}`);
  console.log(`- Provider Health: ${pacing.providerHealth}`);
  // Note: pacing doesn't reflect system_paused directly in status right now, but we can see it in DB.

  console.log("\n=== Success ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
