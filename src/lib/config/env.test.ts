import { describe, expect, it } from "vitest";
import { getServerEnv, resetServerEnvCacheForTests } from "@/lib/config/env";

describe("getServerEnv", () => {
  it("defaults to development app env, seed mode on, and dry_run delivery", () => {
    const env = getServerEnv();
    expect(env.APP_ENV).toBe("development");
    expect(env.DEV_SEED_MODE).toBe(true);
    expect(env.DEFAULT_DELIVERY_MODE).toBe("dry_run");
  });

  it("never defaults DEFAULT_DELIVERY_MODE to live", () => {
    const env = getServerEnv();
    expect(env.DEFAULT_DELIVERY_MODE).not.toBe("live");
  });

  it("treats empty Vercel environment values as unset", () => {
    const originalAppEnv = process.env.APP_ENV;
    const originalDeliveryMode = process.env.DEFAULT_DELIVERY_MODE;
    process.env.APP_ENV = "";
    process.env.DEFAULT_DELIVERY_MODE = "";
    resetServerEnvCacheForTests();

    const env = getServerEnv();

    expect(env.APP_ENV).toBe("development");
    expect(env.DEFAULT_DELIVERY_MODE).toBe("dry_run");

    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalDeliveryMode === undefined) delete process.env.DEFAULT_DELIVERY_MODE;
    else process.env.DEFAULT_DELIVERY_MODE = originalDeliveryMode;
    resetServerEnvCacheForTests();
  });
});
