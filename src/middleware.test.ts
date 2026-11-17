import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { resetServerEnvCacheForTests } from "@/lib/config/env";
import middleware from "../middleware";

const environmentNames = ["VERCEL", "VERCEL_ENV", "APP_ENV", "DEV_SEED_MODE"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

function setEnvironment(values: Partial<Record<(typeof environmentNames)[number], string>>): void {
  for (const name of environmentNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetServerEnvCacheForTests();
}

afterEach(() => {
  setEnvironment(originalEnvironment);
});

describe("middleware runtime boundaries", () => {
  it("blocks Preview requests before application middleware runs", async () => {
    setEnvironment({ VERCEL: "1", VERCEL_ENV: "preview", APP_ENV: "test", DEV_SEED_MODE: "false" });

    const response = await middleware(new NextRequest("https://vitalcap.test/api/cron/discovery"));

    expect(response.status).toBe(503);
  });

  it("passes Production API requests to route-specific authorization", async () => {
    setEnvironment({ VERCEL: "1", VERCEL_ENV: "production", APP_ENV: "production", DEV_SEED_MODE: "false" });

    const response = await middleware(new NextRequest("https://vitalcap.test/api/accounts"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});