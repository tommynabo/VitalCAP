import { describe, expect, it } from "vitest";
import { getCoreEnv, resetServerEnvCacheForTests } from "@/lib/config/env";

describe("getCoreEnv", () => {
  function withProductionEnv(run: () => void) {
    const names = ["APP_ENV", "VERCEL_ENV", "DEV_SEED_MODE", "CRON_SECRET"];
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.VERCEL_ENV = "production";
      process.env.CRON_SECRET = "test-cron-secret";
      run();
    } finally {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
      resetServerEnvCacheForTests();
    }
  }

  it("defaults to development app env, seed mode on, and dry_run delivery", () => {
    const env = getCoreEnv();
    expect(env.APP_ENV).toBe("development");
    expect(env.DEV_SEED_MODE).toBe(true);
    expect(env.DEFAULT_DELIVERY_MODE).toBe("dry_run");
  });

  it("never defaults DEFAULT_DELIVERY_MODE to live", () => {
    const env = getCoreEnv();
    expect(env.DEFAULT_DELIVERY_MODE).not.toBe("live");
  });

  it("uses a production-capable daily raw safety ceiling by default", () => {
    expect(getCoreEnv().ACTIVATION_MAX_DAILY_RAW_REQUESTS).toBe(1500);
  });

  it("treats empty Vercel environment values as unset", () => {
    const originalAppEnv = process.env.APP_ENV;
    const originalDeliveryMode = process.env.DEFAULT_DELIVERY_MODE;
    process.env.APP_ENV = "";
    process.env.DEFAULT_DELIVERY_MODE = "";
    resetServerEnvCacheForTests();

    const env = getCoreEnv();

    expect(env.APP_ENV).toBe("development");
    expect(env.DEFAULT_DELIVERY_MODE).toBe("dry_run");

    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalDeliveryMode === undefined) delete process.env.DEFAULT_DELIVERY_MODE;
    else process.env.DEFAULT_DELIVERY_MODE = originalDeliveryMode;
    resetServerEnvCacheForTests();
  });

  it("rejects production when development seed mode is enabled", () => {
    const originalAppEnv = process.env.APP_ENV;
    const originalSeedMode = process.env.DEV_SEED_MODE;
    process.env.APP_ENV = "production";
    process.env.DEV_SEED_MODE = "true";
    resetServerEnvCacheForTests();

    expect(() => getCoreEnv()).toThrow(/DEV_SEED_MODE=true is forbidden/);

    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalSeedMode === undefined) delete process.env.DEV_SEED_MODE;
    else process.env.DEV_SEED_MODE = originalSeedMode;
    resetServerEnvCacheForTests();
  });

  it("rejects Vercel production when APP_ENV is missing", () => {
    withProductionEnv(() => {
      delete process.env.APP_ENV;
      process.env.DEV_SEED_MODE = "false";
      resetServerEnvCacheForTests();
      expect(() => getCoreEnv()).toThrow(/requires APP_ENV=production/);
    });
  });

  it("rejects Vercel production when APP_ENV is development", () => {
    withProductionEnv(() => {
      process.env.APP_ENV = "development";
      process.env.DEV_SEED_MODE = "false";
      resetServerEnvCacheForTests();
      expect(() => getCoreEnv()).toThrow(/requires APP_ENV=production/);
    });
  });

  it("rejects Vercel production when dev seed mode is enabled", () => {
    withProductionEnv(() => {
      process.env.APP_ENV = "production";
      process.env.DEV_SEED_MODE = "true";
      resetServerEnvCacheForTests();
      expect(() => getCoreEnv()).toThrow(/DEV_SEED_MODE=false/);
    });
  });

  it("accepts a valid Vercel production environment", () => {
    withProductionEnv(() => {
      process.env.APP_ENV = "production";
      process.env.DEV_SEED_MODE = "false";
      resetServerEnvCacheForTests();
      expect(getCoreEnv().VERCEL_ENV).toBe("production");
      expect(getCoreEnv().DEV_SEED_MODE).toBe(false);
    });
  });
});
