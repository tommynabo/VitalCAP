import { z } from "zod";
import { optionalEnvValue, resolveNeonVar } from "@/lib/config/env-utils";

// ── Core Env ───────────────────────────────────────────────────────────
const coreEnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  DEV_SEED_MODE: z.string().optional().transform((v) => (v ?? "true").toLowerCase() === "true"),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  DEFAULT_DELIVERY_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  DEFAULT_BOOKING_URL: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  /**
   * Production throughput guard. This is a daily ceiling, not a per-cron
   * batch size: pacing still requests only the raw volume needed to close the
   * qualified deficit at the observed yield.
   */
  ACTIVATION_MAX_DAILY_RAW_REQUESTS: z.coerce.number().int().min(1).default(1500),
}).superRefine((env, ctx) => {
  if (env.VERCEL_ENV === "production" && optionalEnvValue(process.env.APP_ENV) !== "production") {
    ctx.addIssue({ code: "custom", message: "VERCEL_ENV=production requires APP_ENV=production.", path: ["APP_ENV"] });
  }
  if (env.VERCEL_ENV === "production" && optionalEnvValue(process.env.DEV_SEED_MODE) !== "false") {
    ctx.addIssue({ code: "custom", message: "VERCEL_ENV=production requires DEV_SEED_MODE=false.", path: ["DEV_SEED_MODE"] });
  }
  if (env.APP_ENV === "production" && env.DEV_SEED_MODE) {
    ctx.addIssue({
      code: "custom",
      message: "Hard config error: APP_ENV=production with DEV_SEED_MODE=true is forbidden.",
      path: ["DEV_SEED_MODE"],
    });
  }
  if (env.APP_ENV === "production" && !env.CRON_SECRET) {
    ctx.addIssue({ code: "custom", message: "CRON_SECRET is required in production.", path: ["CRON_SECRET"] });
  }
});

let cachedCoreEnv: z.infer<typeof coreEnvSchema> | null = null;
export function getCoreEnv() {
  if (cachedCoreEnv) return cachedCoreEnv;
  cachedCoreEnv = coreEnvSchema.parse({
    APP_ENV: optionalEnvValue(process.env.APP_ENV),
    VERCEL_ENV: optionalEnvValue(process.env.VERCEL_ENV),
    DEV_SEED_MODE: optionalEnvValue(process.env.DEV_SEED_MODE),
    NEXT_PUBLIC_APP_URL: optionalEnvValue(process.env.NEXT_PUBLIC_APP_URL),
    DEFAULT_DELIVERY_MODE: optionalEnvValue(process.env.DEFAULT_DELIVERY_MODE),
    DEFAULT_BOOKING_URL: optionalEnvValue(process.env.DEFAULT_BOOKING_URL),
    CRON_SECRET: optionalEnvValue(process.env.CRON_SECRET),
    ACTIVATION_MAX_DAILY_RAW_REQUESTS: optionalEnvValue(process.env.ACTIVATION_MAX_DAILY_RAW_REQUESTS),
  });
  return cachedCoreEnv;
}

export function isDevSeedMode(): boolean {
  return getCoreEnv().DEV_SEED_MODE;
}

// ── Database Env ───────────────────────────────────────────────────────────
const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_UNPOOLED: z.string().optional(),
}).superRefine((env, ctx) => {
  if (getCoreEnv().APP_ENV === "production" && !env.DATABASE_URL) {
    ctx.addIssue({ code: "custom", message: "DATABASE_URL is required in production.", path: ["DATABASE_URL"] });
  }
});
let cachedDbEnv: z.infer<typeof databaseEnvSchema> | null = null;
export function getDatabaseEnv() {
  if (cachedDbEnv) return cachedDbEnv;
  cachedDbEnv = databaseEnvSchema.parse({
    DATABASE_URL: resolveNeonVar("DATABASE_URL"),
    DATABASE_URL_UNPOOLED: resolveNeonVar("DATABASE_URL_UNPOOLED"),
  });
  return cachedDbEnv;
}

// ── Maps Env ───────────────────────────────────────────────────────────
const mapsEnvSchema = z.object({
  MAPS_PROVIDER: z.enum(["apify", "mock"]).default("mock"),
  APIFY_API_TOKEN: z.string().optional(),
  APIFY_MAPS_FAST_ACTOR: z.string().default("compass/crawler-google-places"),
  APIFY_MAPS_DEEP_ACTOR: z.string().default("compass/crawler-google-places"),
  APIFY_MAPS_FALLBACK_ACTOR: z.string().default("compass/crawler-google-places"),
  APIFY_MAPS_CONTACT_ENRICHMENT_ACTOR: z.string().optional(),
  APIFY_DAILY_COST_LIMIT_USD: z.coerce.number().positive().default(15),
  APIFY_BATCH_COST_LIMIT_USD: z.coerce.number().default(2),
}).superRefine((env, ctx) => {
  if (getCoreEnv().APP_ENV === "production" && env.MAPS_PROVIDER === "mock") {
    ctx.addIssue({ code: "custom", message: "MAPS_PROVIDER=mock is forbidden in production.", path: ["MAPS_PROVIDER"] });
  }
  // Remove the hard fail for missing APIFY_API_TOKEN in production! Let it be typed failure instead.
});
let cachedMapsEnv: z.infer<typeof mapsEnvSchema> | null = null;
export function getMapsEnv() {
  if (cachedMapsEnv) return cachedMapsEnv;
  cachedMapsEnv = mapsEnvSchema.parse({
    MAPS_PROVIDER: process.env.MAPS_PROVIDER,
    APIFY_API_TOKEN: optionalEnvValue(process.env.APIFY_API_TOKEN),
    APIFY_MAPS_FAST_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_FAST_ACTOR),
    APIFY_MAPS_DEEP_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_DEEP_ACTOR),
    APIFY_MAPS_FALLBACK_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_FALLBACK_ACTOR),
    APIFY_MAPS_CONTACT_ENRICHMENT_ACTOR: optionalEnvValue(process.env.APIFY_MAPS_CONTACT_ENRICHMENT_ACTOR),
    APIFY_DAILY_COST_LIMIT_USD: optionalEnvValue(process.env.APIFY_DAILY_COST_LIMIT_USD),
    APIFY_BATCH_COST_LIMIT_USD: optionalEnvValue(process.env.APIFY_BATCH_COST_LIMIT_USD),
  });
  return cachedMapsEnv;
}

// ── Serper Env ───────────────────────────────────────────────────────────
const serperEnvSchema = z.object({
  SERP_PROVIDER: z.enum(["serper", "disabled", "mock"]).default("disabled"),
  SERPER_API_KEY: z.string().optional(),
  SERPER_DAILY_COST_LIMIT_USD: z.coerce.number().nonnegative().default(0.5),
  SERPER_COUNTRY: z.string().default("es"),
  SERPER_LANGUAGE: z.string().default("es"),
});
let cachedSerperEnv: z.infer<typeof serperEnvSchema> | null = null;
export function getSerperEnv() {
  if (cachedSerperEnv) return cachedSerperEnv;
  cachedSerperEnv = serperEnvSchema.parse({
    SERP_PROVIDER: process.env.SERP_PROVIDER,
    SERPER_API_KEY: optionalEnvValue(process.env.SERPER_API_KEY),
    SERPER_DAILY_COST_LIMIT_USD: optionalEnvValue(process.env.SERPER_DAILY_COST_LIMIT_USD),
    SERPER_COUNTRY: optionalEnvValue(process.env.SERPER_COUNTRY),
    SERPER_LANGUAGE: optionalEnvValue(process.env.SERPER_LANGUAGE),
  });
  return cachedSerperEnv;
}

// ── Verification Env ───────────────────────────────────────────────────────────
const verificationEnvSchema = z.object({
  EMAIL_VERIFICATION_PROVIDER: z.enum(["millionverifier", "disabled", "mock"]).default("disabled"),
  MILLIONVERIFIER_API_KEY: z.string().optional(),
});
let cachedVerificationEnv: z.infer<typeof verificationEnvSchema> | null = null;
export function getVerificationEnv() {
  if (cachedVerificationEnv) return cachedVerificationEnv;
  cachedVerificationEnv = verificationEnvSchema.parse({
    EMAIL_VERIFICATION_PROVIDER: process.env.EMAIL_VERIFICATION_PROVIDER,
    MILLIONVERIFIER_API_KEY: optionalEnvValue(process.env.MILLIONVERIFIER_API_KEY),
  });
  return cachedVerificationEnv;
}

// ── Delivery Env ───────────────────────────────────────────────────────────
const deliveryEnvSchema = z.object({
  EMAIL_DELIVERY_PROVIDER: z.enum(["instantly", "disabled", "mock"]).default("disabled"),
  INSTANTLY_API_KEY: z.string().optional(),
  INSTANTLY_WEBHOOK_SECRET: z.string().optional(),
  SMS_PROVIDER: z.literal("disabled").default("disabled"),
});
let cachedDeliveryEnv: z.infer<typeof deliveryEnvSchema> | null = null;
export function getDeliveryEnv() {
  if (cachedDeliveryEnv) return cachedDeliveryEnv;
  cachedDeliveryEnv = deliveryEnvSchema.parse({
    EMAIL_DELIVERY_PROVIDER: process.env.EMAIL_DELIVERY_PROVIDER,
    INSTANTLY_API_KEY: optionalEnvValue(process.env.INSTANTLY_API_KEY),
    INSTANTLY_WEBHOOK_SECRET: optionalEnvValue(process.env.INSTANTLY_WEBHOOK_SECRET),
    SMS_PROVIDER: process.env.SMS_PROVIDER as any,
  });
  return cachedDeliveryEnv;
}

// ── Intelligence Env ───────────────────────────────────────────────────────────
const intelligenceEnvSchema = z.object({
  LLM_PROVIDER: z.enum(["openai", "disabled", "mock"]).default("disabled"),
  LLM_PROVIDER_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  PROSPECT_LLM_MODEL: z.string().optional(),
  LLM_DAILY_COST_LIMIT_USD: z.coerce.number().default(10),
  LLM_BATCH_COST_LIMIT_USD: z.coerce.number().default(2),
});
let cachedIntelligenceEnv: z.infer<typeof intelligenceEnvSchema> | null = null;
export function getIntelligenceEnv() {
  if (cachedIntelligenceEnv) return cachedIntelligenceEnv;
  cachedIntelligenceEnv = intelligenceEnvSchema.parse({
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_PROVIDER_API_KEY: optionalEnvValue(process.env.LLM_PROVIDER_API_KEY),
    LLM_MODEL: optionalEnvValue(process.env.LLM_MODEL),
    PROSPECT_LLM_MODEL: optionalEnvValue(process.env.PROSPECT_LLM_MODEL),
    LLM_DAILY_COST_LIMIT_USD: optionalEnvValue(process.env.LLM_DAILY_COST_LIMIT_USD),
    LLM_BATCH_COST_LIMIT_USD: optionalEnvValue(process.env.LLM_BATCH_COST_LIMIT_USD),
  });
  return cachedIntelligenceEnv;
}

export function resetServerEnvCacheForTests(): void {
  cachedCoreEnv = null;
  cachedDbEnv = null;
  cachedMapsEnv = null;
  cachedSerperEnv = null;
  cachedVerificationEnv = null;
  cachedDeliveryEnv = null;
  cachedIntelligenceEnv = null;
}
