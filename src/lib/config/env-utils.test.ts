import { afterEach, describe, expect, it } from "vitest";
import { resolveNeonVar } from "./env-utils";

const databaseEnvNames = ["VERCEL", "DATABASE_URL", "Vitalcap_DATABASE_URL"] as const;
const previousDatabaseEnv = new Map(databaseEnvNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of databaseEnvNames) {
    const previousValue = previousDatabaseEnv.get(name);
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
  }
});

describe("resolveNeonVar", () => {
  it("prefers the prefixed Neon integration URL on Vercel", () => {
    process.env.VERCEL = "1";
    process.env.DATABASE_URL = "postgresql://ordinary.example/default";
    process.env.Vitalcap_DATABASE_URL = "postgresql://test-only.example/test";

    expect(resolveNeonVar("DATABASE_URL")).toBe("postgresql://test-only.example/test");
  });

  it("prefers the standard URL outside Vercel", () => {
    delete process.env.VERCEL;
    process.env.DATABASE_URL = "postgresql://ordinary.example/default";
    process.env.Vitalcap_DATABASE_URL = "postgresql://prefixed.example/default";

    expect(resolveNeonVar("DATABASE_URL")).toBe("postgresql://ordinary.example/default");
  });
});