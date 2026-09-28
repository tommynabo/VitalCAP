import { neon } from "@neondatabase/serverless";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const sql = neon(process.env.DATABASE_URL);
  const workspaces = await sql`SELECT id, name FROM workspaces LIMIT 1;`;
  console.log("Workspaces:", JSON.stringify(workspaces, null, 2));
  const result = await sql`SELECT id, name, status, autopilot_enabled, engine_type, country, daily_soft_target, workspace_id FROM campaigns WHERE engine_type = 'maps_fast' AND country = 'ES';`;
  console.log("Campaigns:", JSON.stringify(result, null, 2));
}

main().catch(console.error);
