import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { resetServerEnvCacheForTests } from "@/lib/config/env";

const environmentNames = ["APP_ENV", "VERCEL_ENV", "DEV_SEED_MODE", "DATABASE_URL", "MAPS_PROVIDER", "DEFAULT_DELIVERY_MODE"];

describe("GET /api/health", () => {
  afterEach(() => {
    for (const name of environmentNames) delete process.env[name];
    resetServerEnvCacheForTests();
  });

  it("exposes safe runtime state without secrets", async () => {
    process.env.APP_ENV = "development";
    process.env.DEV_SEED_MODE = "true";
    process.env.MAPS_PROVIDER = "mock";
    process.env.DEFAULT_DELIVERY_MODE = "dry_run";
    resetServerEnvCacheForTests();

    const body = await GET().json();

    expect(body).toMatchObject({ status: "ok", appEnv: "development", devSeedMode: true, databaseConfigured: false, mapsProvider: "mock", deliveryMode: "dry_run" });
    expect(body).not.toHaveProperty("DATABASE_URL");
    expect(body).not.toHaveProperty("APIFY_API_TOKEN");
    expect(body).not.toHaveProperty("NEON_AUTH_COOKIE_SECRET");
  });
});