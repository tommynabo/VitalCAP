import { neon } from "@neondatabase/serverless";

const neonPrefixes = ["Vitalcap"];

function resolveDatabaseUrl(name: "DATABASE_URL" | "DATABASE_URL_UNPOOLED"): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  return neonPrefixes.map((prefix) => process.env[`${prefix}_${name}`]?.trim()).find(Boolean);
}

async function run() {
  const dbUrl = resolveDatabaseUrl("DATABASE_URL");
  if (!dbUrl) {
    console.error("NO DATABASE_URL FOUND IN ENVIRONMENT!");
    console.log(Object.keys(process.env).join(", "));
    return;
  }

  const db = neon(dbUrl);

  const migrations = await db`SELECT filename FROM vitalcap_migrations ORDER BY filename`;
  console.log("=== MIGRATIONS ===");
  migrations.forEach(m => console.log(m.filename));

  const tables = await db`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  console.log("=== TABLES ===");
  tables.map(t => String(t.table_name)).filter(t => t.includes("website")).forEach(t => console.log(t));

  const indexes = await db`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%website%'`;
  console.log("=== INDEXES ===");
  indexes.forEach(i => console.log(i.indexname, i.indexdef));
}

run().catch(console.error);
