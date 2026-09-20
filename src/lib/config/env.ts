import { z } from "zod";

/**
 * Server-side environment schema. Only variable *names* are defined in
 * `.env.example` (no secrets in source). This module validates presence/
 * shape so a misconfigured deployment fails fast instead of silently
 * running with `undefined` credentials.
 */
const serverEnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEV_SEED_MODE: z
    .string()
    .optional()
    .transform((value) => (value ?? "true").toLowerCase() === "true"),
  DEFAULT_DELIVERY_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(): ServerEnv {
  return serverEnvSchema.parse({
    APP_ENV: process.env.APP_ENV,
    DEV_SEED_MODE: process.env.DEV_SEED_MODE,
    DEFAULT_DELIVERY_MODE: process.env.DEFAULT_DELIVERY_MODE,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
