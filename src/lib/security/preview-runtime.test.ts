import { describe, expect, it } from "vitest";
import { assertNotVercelPreview, isDeployedVercelPreview, PreviewRuntimeBlockedError } from "./preview-runtime";

const environmentNames = ["VERCEL", "VERCEL_ENV", "NODE_ENV"] as const;

function withEnvironment(values: Partial<Record<(typeof environmentNames)[number], string>>, run: () => void): void {
  const original = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of environmentNames) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else Reflect.set(process.env, name, value);
    }
    run();
  } finally {
    for (const name of environmentNames) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else Reflect.set(process.env, name, value);
    }
  }
}

describe("Vercel Preview runtime policy", () => {
  it("identifies a deployed Preview independently of APP_ENV", () => {
    withEnvironment({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" }, () => {
      expect(isDeployedVercelPreview()).toBe(true);
      expect(() => assertNotVercelPreview("Database access")).toThrow(PreviewRuntimeBlockedError);
    });
  });

  it("does not classify local or test processes as deployed Preview", () => {
    withEnvironment({ VERCEL: undefined, VERCEL_ENV: "preview", NODE_ENV: "production" }, () => {
      expect(isDeployedVercelPreview()).toBe(false);
    });
    withEnvironment({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "test" }, () => {
      expect(isDeployedVercelPreview()).toBe(true);
      expect(() => assertNotVercelPreview("Provider requests")).toThrow(PreviewRuntimeBlockedError);
    });
  });

  it("does not classify Vercel Production as Preview", () => {
    withEnvironment({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" }, () => {
      expect(isDeployedVercelPreview()).toBe(false);
      expect(() => assertNotVercelPreview("Database access")).not.toThrow();
    });
  });
});