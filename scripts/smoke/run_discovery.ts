import { neon } from "@neondatabase/serverless";
import { enqueueDiscoveryJob } from "../../src/infrastructure/neon/repositories/job-queue";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const sql = neon(process.env.DATABASE_URL);
  
  const campaigns = await sql`SELECT id FROM campaigns WHERE engine_type = 'maps_fast' AND country_code = 'ES' LIMIT 1`;
  if (!campaigns.length) throw new Error("No maps_fast campaigns found");
  const campaignId = campaigns[0]!.id;
  
  console.log("Found Campaign:", campaignId);
  
  const jobId = await enqueueDiscoveryJob({
    campaignId,
    type: "run_engine_batch",
    payload: {
      engineType: "maps_fast",
      desiredRawCount: 5,
      planningWindow: new Date().toISOString() + ":smoke",
      reason: "Smoke test",
      origin: "normal",
      seedQuery: "farmacia",
      seedGeography: "Álava"
    },
    idempotencyKey: "smoke_test_" + Date.now(),
  });
  
  console.log("Enqueued discovery job:", jobId);
  console.log("Run the following to trigger production:");
  console.log("curl -X GET -H 'Authorization: Bearer <CRON_SECRET>' https://vitalcapproject.vercel.app/api/cron/discovery");
}

main().catch(console.error);
