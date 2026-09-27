import { z } from "zod";
import { optionalEnvValue, resolveNeonVar } from "@/lib/config/env-utils";

/**
 * Auth-specific environment schema used by the middleware and auth routes.
 * It deliberately validates only the variables required for authentication.
 * Other provider‑specific variables are NOT validated here, so their absence
 * does not break the public UI.
 */
const authEnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  DEV_SEED_MODE: z.string().optional().transform((v) => (v ?? "true").toLowerCase() === "true"),
  // Neon Auth variables (injected by Vercel/Neon integration)
  NEON_AUTH_BASE_URL: z.string().optional(),
  NEON_AUTH_COOKIE_SECRET: z.string().optional().refine((s) => !s || s.length >= 32, {
    message: "NEON_AUTH_COOKIE_SECRET must be at least 32 characters in production.",
  }),
}).superRefine((env, ctx) => {
  if (env.VERCEL_ENV === "production" && optionalEnvValue(process.env.APP_ENV) !== "production") {
    ctx.addIssue({ code: "custom", message: "VERCEL_ENV=production requires APP_ENV=production.", path: ["APP_ENV"] });
  }
  if (env.VERCEL_ENV === "production" && optionalEnvValue(process.env.DEV_SEED_MODE) !== "false") {
    ctx.addIssue({ code: "custom", message: "VERCEL_ENV=production requires DEV_SEED_MODE=false.", path: ["DEV_SEED_MODE"] });
  }
  if (env.APP_ENV === "production" && env.DEV_SEED_MODE) {
    ctx.addIssue({ code: "custom", message: "Hard config error: APP_ENV=production with DEV_SEED_MODE=true is forbidden.", path: ["DEV_SEED_MODE"] });
  }
  if (env.APP_ENV === "production" && (!env.NEON_AUTH_BASE_URL)) {
    ctx.addIssue({ code: "custom", message: "NEON_AUTH_BASE_URL is required in production.", path: ["NEON_AUTH_BASE_URL"] });
  }
  if (env.APP_ENV === "production" && (!env.NEON_AUTH_COOKIE_SECRET || env.NEON_AUTH_COOKIE_SECRET.length < 32)) {
    ctx.addIssue({ code: "custom", message: "NEON_AUTH_COOKIE_SECRET must be at least 32 characters in production.", path: ["NEON_AUTH_COOKIE_SECRET"] });
  }
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

let cachedAuthEnv: AuthEnv | null = null;

/**
 * Parses and validates only the authentication‑related environment variables.
 * Throws a ZodError on hard violations (production without required auth config).
 */
export function getAuthEnv(): AuthEnv {
  if (cachedAuthEnv) return cachedAuthEnv;
  cachedAuthEnv = authEnvSchema.parse({
    APP_ENV: optionalEnvValue(process.env.APP_ENV),
    VERCEL_ENV: optionalEnvValue(process.env.VERCEL_ENV),
    DEV_SEED_MODE: optionalEnvValue(process.env.DEV_SEED_MODE),
    NEON_AUTH_BASE_URL: resolveNeonVar("NEON_AUTH_BASE_URL"),
    NEON_AUTH_COOKIE_SECRET: optionalEnvValue(process.env.NEON_AUTH_COOKIE_SECRET),
  });
  return cachedAuthEnv;
}

/** Test‑only helper to clear the memoised auth env. */
export function resetAuthEnvCacheForTests(): void {
  cachedAuthEnv = null;
}
