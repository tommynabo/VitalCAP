import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for `npm run db:generate` / `db:migrate` (Prompt 7).
 * Migrations use the UNPOOLED Neon connection string per current Neon/Vercel
 * migration guidance (pooled PgBouncer connections can reject the session-
 * level statements DDL migrations sometimes need). Runtime queries continue
 * to use the pooled `DATABASE_URL` via `src/infrastructure/neon/db.ts`.
 *
 * Reads directly from `process.env` (not `getServerEnv()`) because
 * drizzle-kit runs as a standalone CLI outside the Next.js server runtime,
 * before any app-level env resolution/caching applies. It still respects the
 * Neon integration's prefixed variable name as a fallback.
 */
const NEON_VAR_PREFIXES = ["Vitalcap"];

function resolveNeonVar(standardName: string): string | undefined {
  const direct = process.env[standardName];
  if (direct) return direct;
  for (const prefix of NEON_VAR_PREFIXES) {
    const prefixed = process.env[`${prefix}_${standardName}`];
    if (prefixed) return prefixed;
  }
  return undefined;
}

const migrationUrl = resolveNeonVar("DATABASE_URL_UNPOOLED") ?? resolveNeonVar("DATABASE_URL");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/neon/schema/index.ts",
  out: "./drizzle",
  ...(migrationUrl ? { dbCredentials: { url: migrationUrl } } : {}),
  strict: true,
  verbose: true,
});
