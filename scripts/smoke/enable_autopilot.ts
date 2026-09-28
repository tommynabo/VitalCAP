import { neon } from "@neondatabase/serverless";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const sql = neon(process.env.DATABASE_URL);
  
  const campaigns = await sql`SELECT workspace_id FROM campaigns WHERE engine_type = 'maps_fast' AND name = 'Maps Fast Production Pilot' LIMIT 1`;
  const workspaceId = campaigns[0]!.workspace_id;
  
  await sql`
    INSERT INTO autopilot_settings (workspace_id, enabled, emergency_stopped)
    VALUES (${workspaceId}, true, false)
    ON CONFLICT (workspace_id) DO UPDATE SET enabled = true, emergency_stopped = false
  `;
  console.log("Autopilot enabled for workspace:", workspaceId);
}
main();
