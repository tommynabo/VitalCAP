import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const migrationDirectory = join(process.cwd(), "supabase", "migrations-neon");
const migrationTable = "vitalcap_migrations";
const neonPrefixes = ["Vitalcap"];

function resolveDatabaseUrl(name: "DATABASE_URL" | "DATABASE_URL_UNPOOLED"): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  return neonPrefixes.map((prefix) => process.env[`${prefix}_${name}`]?.trim()).find(Boolean);
}

const databaseUrl = resolveDatabaseUrl("DATABASE_URL_UNPOOLED") ?? resolveDatabaseUrl("DATABASE_URL");

if (!databaseUrl) {
  throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required for db:migrate.");
}

const db = neon(databaseUrl);

await db.unsafe(`
  CREATE TABLE IF NOT EXISTS ${migrationTable} (
    id integer PRIMARY KEY,
    filename text NOT NULL UNIQUE,
    hash text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const files = (await readdir(migrationDirectory))
  .filter((filename) => filename.endsWith(".sql"))
  .sort();

for (const [index, filename] of files.entries()) {
  const contents = await readFile(join(migrationDirectory, filename), "utf8");
  const hash = createHash("sha256").update(contents).digest("hex");
  const existing = await db`
    SELECT filename, hash
    FROM ${db.unsafe(migrationTable)}
    WHERE filename = ${filename}
  `;
  const applied = existing[0] as { filename: string; hash: string } | undefined;

  if (applied) {
    if (applied.hash !== hash) {
      throw new Error(`Migration ${filename} was changed after it was applied.`);
    }
    console.log(`Migration ${filename}: already applied`);
    continue;
  }

  console.log(`Applying migration ${filename}`);
  await db.transaction([
    db`${db.unsafe(contents)}`,
    db`INSERT INTO ${db.unsafe(migrationTable)} (id, filename, hash) VALUES (${index + 1}, ${filename}, ${hash})`,
  ]);
  console.log(`Migration ${filename}: applied`);
}

console.log(`Database migrations: PASS (${files.length} versioned migration${files.length === 1 ? "" : "s"})`);