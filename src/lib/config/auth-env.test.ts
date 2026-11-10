import { describe, expect, it } from "vitest";
import { getAuthEnv, resetAuthEnvCacheForTests } from "./auth-env";

const environmentNames = [
  "VERCEL",
  "VERCEL_ENV",
  "NODE_ENV",
  "APP_ENV",
  "DEV_SEED_MODE",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_COOKIE_SECRET",
] as const;

function withEnvironment(run: () => void): void {
  const original = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of environmentNames) delete process.env[name];
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    Reflect.set(process.env, "NODE_ENV", "test");
    resetAuthEnvCacheForTests();
    run();
  } finally {
    for (const name of environmentNames) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else Reflect.set(process.env, name, value);
    }
    resetAuthEnvCacheForTests();
  }
}

describe("getAuthEnv in Vercel Preview", () => {
  it("defaults to real authentication even when NODE_ENV is test", () => {
    withEnvironment(() => {
      expect(getAuthEnv().DEV_SEED_MODE).toBe(false);
    });
  });

  it("rejects enabled development seed mode and APP_ENV=production", () => {
    withEnvironment(() => {
      process.env.DEV_SEED_MODE = "true";
      expect(() => getAuthEnv()).toThrow();

      resetAuthEnvCacheForTests();
      process.env.DEV_SEED_MODE = "false";
      process.env.APP_ENV = "production";
      expect(() => getAuthEnv()).toThrow();
    });
  });
});