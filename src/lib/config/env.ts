import { z } from "zod";

/**
 * Server-side environment schema (Prompt 7 — Neon production wiring). Only
 * variable *names* are defined in `.env.example` (no secrets in source).
 * This module validates presence/shape so a misconfigured deployment fails
 * fast instead of silently running with `undefined` credentials, and
 * enforces the hard safety rule that production can never boot in dev-seed
 * mode or with a mock provider silently substituted for a real one.
 *
 * Neon's Vercel marketplace integration injects DB/auth variables with a
 * resource-name prefix (observed in this project as `Vitalcap_*`, e.g.
 * `Vitalcap_DATABASE_URL`). Every Neon-sourced variable below is resolved
 * with `resolveNeonVar`, which prefers the unprefixed standard name (so a
 * plain local `.env.local` keeps working) and falls back to the prefixed
 * name actually injected by the integration. Do not hard-code a different
 * prefix — if the integration is re-created under a different resource
 * name, update `NEON_VAR_PREFIXES` only.
 */

const NEON_VAR_PREFIXES = ["Vitalcap"];

function optionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveNeonVar(standardName: string): string | undefined {
  const direct = optionalEnvValue(process.env[standardName]);
  if (direct) return direct;
  for (const prefix of NEON_VAR_PREFIXES) {
    const prefixed = optionalEnvValue(process.env[`${prefix}_${standardName}`]);
    if (prefixed) return prefixed;
  }
  return undefined;
}

const serverEnvSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "production"]).default("development"),
    DEV_SEED_MODE: z
      .string()
      .optional()
      .transform((value) => (value ?? "true").toLowerCase() === "true"),
    NEXT_PUBLIC_APP_URL: z.string().optional(),
    DEFAULT_DELIVERY_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
    DEFAULT_BOOKING_URL: z.string().optional(),
    CRON_SECRET: z.string().optional(),

    // ── Neon database (injected by the Vercel/Neon integration) ──────────
    DATABASE_URL: z.string().optional(),
    DATABASE_URL_UNPOOLED: z.string().optional(),

    // ── Neon Auth (Managed Better Auth) ───────────────────────────────────
    NEON_AUTH_BASE_URL: z.string().optional(),
    NEON_AUTH_COOKIE_SECRET: z.string().optional(),

    // ── Discovery: Apify (Maps) ───────────────────────────────────────────
    MAPS_PROVIDER: z.enum(["apify", "mock"]).default("mock"),
    APIFY_API_TOKEN: z.string().optional(),
    APIFY_MAPS_FAST_ACTOR: z.string().default("compass/crawler-google-places"),
    APIFY_MAPS_DEEP_ACTOR: z.string().default("compass/crawler-google-places"),
    APIFY_MAPS_FALLBACK_ACTOR: z.string().default("compass/crawler-google-places"),
    APIFY_MAPS_CONTACT_ENRICHMENT_ACTOR: z.string().optional(),
    APIFY_DAILY_COST_LIMIT_USD: z.coerce.number().default(10),
    APIFY_BATCH_COST_LIMIT_USD: z.coerce.number().default(2),

    // ── Discovery: Serper (SERP + LinkedIn owner) ─────────────────────────
    SERP_PROVIDER: z.enum(["serper", "disabled", "mock"]).default("disabled"),
    SERPER_API_KEY: z.string().optional(),
    SERPER_COUNTRY: z.string().default("es"),
    SERPER_LANGUAGE: z.string().default("es"),

    // ── Email verification ────────────────────────────────────────────────
    EMAIL_VERIFICATION_PROVIDER: z.enum(["millionverifier", "disabled", "mock"]).default("disabled"),
    MILLIONVERIFIER_API_KEY: z.string().optional(),

    // ── Email delivery: Instantly v2 ──────────────────────────────────────
    EMAIL_DELIVERY_PROVIDER: z.enum(["instantly", "disabled", "mock"]).default("disabled"),
    INSTANTLY_API_KEY: z.string().optional(),
    INSTANTLY_WEBHOOK_SECRET: z.string().optional(),

    // ── SMS (disabled until a vendor is documented) ───────────────────────
    SMS_PROVIDER: z.literal("disabled").default("disabled"),

    // ── LLM (AI Setter) ────────────────────────────────────────────────────
    LLM_PROVIDER: z.enum(["openai", "disabled", "mock"]).default("disabled"),
    LLM_PROVIDER_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default("gpt-4.1-mini"),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production" && env.DEV_SEED_MODE) {
      ctx.addIssue({
        code: "custom",
        message:
          "Hard config error: APP_ENV=production with DEV_SEED_MODE=true is forbidden. " +
          "Production must never render seed/demo data. Set DEV_SEED_MODE=false.",
        path: ["DEV_SEED_MODE"],
      });
    }
    if (env.APP_ENV === "production" && env.MAPS_PROVIDER === "mock") {
      ctx.addIssue({ code: "custom", message: "MAPS_PROVIDER=mock is forbidden in production.", path: ["MAPS_PROVIDER"] });
    }
    if (env.APP_ENV === "production" && !env.CRON_SECRET) {
      ctx.addIssue({ code: "custom", message: "CRON_SECRET is required in production.", path: ["CRON_SECRET"] });
    }
    if (env.APP_ENV === "production" && !env.DATABASE_URL) {
      ctx.addIssue({ code: "custom", message: "DATABASE_URL is required in production.", path: ["DATABASE_URL"] });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * Parses and validates the process environment. Throws on any hard
 * violation (e.g. production + seed mode) so a misconfigured deployment
 * fails at boot instead of silently serving fake data or running with a
 * disabled safety control. Result is memoized per process.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  cached = serverEnvSchema.parse({
    APP_ENV: optionalEnvValue(process.env.APP_ENV),
    DEV_SEED_MODE: optionalEnvValue(process.env.DEV_SEED_MODE),
    NEXT_PUBLIC_APP_URL: optionalEnvValue(process.env.NEXT_PUBLIC_APP_URL),
    DEFAULT_DELIVERY_MODE: optionalEnvValue(process.env.DEFAULT_DELIVERY_MODE),
    DEFAULT_BOOKING_URL: optionalEnvValue(process.env.DEFAULT_BOOKING_URL),
    CRON_SECRET: optionalEnvValue(process.env.CRON_SECRET),

    DATABASE_URL: resolveNeonVar("DATABASE_URL"),
    DATABASE_URL_UNPOOLED: resolveNeonVar("DATABASE_URL_UNPOOLED"),

    NEON_AUTH_BASE_URL: resolveNeonVar("NEON_AUTH_BASE_URL"),
    NEON_AUTH_COOKIE_SECRET: process.env.NEON_AUTH_COOKIE_SECRET,

    MAPS_PROVIDER: process.env.MAPS_PROVIDER,
    APIFY_API_TOKEN: optionalEnvValue(process.env.APIFY_API_TOKEN),
    APIFY_MAPS_FAST_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_FAST_ACTOR),
    APIFY_MAPS_DEEP_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_DEEP_ACTOR),
    APIFY_MAPS_FALLBACK_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_FALLBACK_ACTOR),
    APIFY_MAPS_CONTACT_ENRICHMENT_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_CONTACT_ENRICHMENT_ACTOR),
    APIFY_DAILY_COST_LIMIT_USD: optionalEnvValue(process.env.APIFY_DAILY_COST_LIMIT_USD),
    APIFY_BATCH_COST_LIMIT_USD: optionalEnvValue(process.env.APIFY_BATCH_COST_LIMIT_USD),

    SERP_PROVIDER: process.env.SERP_PROVIDER,
    SERPER_API_KEY: optionalEnvValue(process.env.SERPER_API_KEY),
    SERPER_COUNTRY: optionalEnvValue(process.env.SERPER_COUNTRY),
    SERPER_LANGUAGE: optionalEnvValue(process.env.SERPER_LANGUAGE),

    EMAIL_VERIFICATION_PROVIDER: process.env.EMAIL_VERIFICATION_PROVIDER,
    MILLIONVERIFIER_API_KEY: optionalEnvValue(process.env.MILLIONVERIFIER_API_KEY),

    EMAIL_DELIVERY_PROVIDER: process.env.EMAIL_DELIVERY_PROVIDER,
    INSTANTLY_API_KEY: optionalEnvValue(process.env.INSTANTLY_API_KEY),
    INSTANTLY_WEBHOOK_SECRET: optionalEnvValue(process.env.INSTANTLY_WEBHOOK_SECRET),

    SMS_PROVIDER: process.env.SMS_PROVIDER,

    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_PROVIDER_API_KEY: optionalEnvValue(process.env.LLM_PROVIDER_API_KEY),
    LLM_MODEL: optionalEnvValue(process.env.LLM_MODEL),
  });
  return cached;
}

/** Test-only: clears the memoized env so a test can re-parse under a different process.env. */
export function resetServerEnvCacheForTests(): void {
  cached = null;
}

export function isDevSeedMode(): boolean {
  return getServerEnv().DEV_SEED_MODE;
}
