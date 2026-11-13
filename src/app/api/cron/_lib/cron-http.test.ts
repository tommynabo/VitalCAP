import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isAuthorizedCronRequest } from "./cron-http";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cron authorization in Vercel Preview", () => {
  it("rejects discovery execution before checking a configured cron secret", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");

    const request = new NextRequest("https://vitalcap.test/api/cron/discovery", {
      headers: { authorization: "Bearer test-cron-secret" },
    });

    expect(isAuthorizedCronRequest(request)).toBe(false);
  });
});