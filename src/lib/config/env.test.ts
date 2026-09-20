import { describe, expect, it } from "vitest";
import { getServerEnv } from "@/lib/config/env";

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
});
