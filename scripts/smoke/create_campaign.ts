import { neon } from "@neondatabase/serverless";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const sql = neon(process.env.DATABASE_URL);
  
  const workspaces = await sql`SELECT id FROM workspaces LIMIT 1`;
  if (!workspaces.length) throw new Error("No workspaces found");
  const workspaceId = workspaces[0]!.id;
  
  const offers = await sql`SELECT id FROM offers WHERE workspace_id = ${workspaceId} LIMIT 1`;
  let offerId = offers[0]?.id;
  if (!offerId) {
    const res = await sql`
      INSERT INTO offers (workspace_id, name, company, description, primary_cta, booking_url, active)
      VALUES (${workspaceId}, 'Test Offer', 'Test Company', 'Description', 'CTA', 'http://book', true)
      RETURNING id
    `;
    offerId = res[0]!.id;
  }
  
  const res = await sql`
    INSERT INTO campaigns (workspace_id, offer_id, name, status, country_code, engine_type, daily_soft_target, autopilot_enabled, time_zone, desired_channel_mix)
    VALUES (${workspaceId}, ${offerId}, 'Maps Fast Production Pilot', 'active', 'ES', 'maps_fast', 5, true, 'Europe/Madrid', '{"email":100,"sms":0}'::jsonb)
    RETURNING id
  `;
  console.log("Created Campaign ID:", res[0]!.id);
}

main().catch(console.error);
