import { neon } from "@neondatabase/serverless";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const sql = neon(process.env.DATABASE_URL);
  
  const runs = await sql`
    SELECT id, status, provider_type, external_run_id, dataset_id, 
           items_requested, items_returned, usage_total_usd
    FROM provider_runs 
    ORDER BY created_at DESC 
    LIMIT 1
  `;
  console.log(JSON.stringify(runs, null, 2));
}
main();
