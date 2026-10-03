import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getDatabaseEnv } from "@/lib/config/env";
import * as schema from "./schema";

/**
 * Single shared Drizzle client for Neon (HTTP driver — safe to use from
 * serverless/edge Node runtimes without connection pooling concerns). Uses
 * the pooled `DATABASE_URL` from `getServerEnv()`, which already resolves
 * the Neon Vercel integration's prefixed variable names
 * (`src/lib/config/env.ts`). Do not read `process.env.DATABASE_URL`
 * directly anywhere else — always go through this module or `getServerEnv()`.
 */
let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
let cachedSql: ReturnType<typeof neon<false, false>> | undefined;

export function getNeonSql(): ReturnType<typeof neon<false, false>> {
  if (cachedSql) return cachedSql;
  const env = getDatabaseEnv();
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured. Set it (or the Neon-integration-provided " +
        "Vitalcap_DATABASE_URL) before calling getDb().",
    );
  }
  const sqlClient = neon(env.DATABASE_URL);
  cachedSql = sqlClient;
  return sqlClient;
}

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (cachedDb) return cachedDb;
  const db = drizzle({ client: getNeonSql(), schema });
  cachedDb = db;
  return db;
}

export function resetDbCacheForTests() {
  cachedDb = undefined;
  cachedSql = undefined;
}

export { schema };
