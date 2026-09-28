import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { resetServerEnvCacheForTests } from "@/lib/config/env";
import { resetAuthEnvCacheForTests } from "@/lib/config/auth-env";

const environmentNames = ["APP_ENV", "VERCEL_ENV", "DEV_SEED_MODE", "DATABASE_URL", "MAPS_PROVIDER", "DEFAULT_DELIVERY_MODE", "NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET", "APIFY_API_TOKEN"];

describe("GET /api/health", () => {
  afterEach(() => {
    for (const name of environmentNames) delete process.env[name];
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();
  });

  it("exposes safe runtime state without secrets", async () => {
    process.env.APP_ENV = "development";
    process.env.DEV_SEED_MODE = "true";
    process.env.MAPS_PROVIDER = "mock";
    process.env.DEFAULT_DELIVERY_MODE = "dry_run";
    resetServerEnvCacheForTests();
    resetAuthEnvCacheForTests();

    const body = await GET().json();

    expect(body).toMatchObject({
      status: "ok",
      appEnv: "development",
      devSeedMode: true,
      databaseConfigured: false,
      auth: { configured: false },
      maps: { provider: "mock", configured: true },
      intelligence: { provider: "disabled", configured: true },
      verification: { provider: "disabled" },
      delivery: { mode: "dry_run", provider: "disabled" }
    });
    expect(body).not.toHaveProperty("DATABASE_URL");
    expect(body).not.toHaveProperty("APIFY_API_TOKEN");
    expect(body).not.toHaveProperty("NEON_AUTH_COOKIE_SECRET");
  });
});