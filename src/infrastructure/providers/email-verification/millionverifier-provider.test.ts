import { describe, expect, it, vi } from "vitest";
import { MillionVerifierEmailVerificationProvider } from "./millionverifier-provider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("MillionVerifierEmailVerificationProvider", () => {
  it("maps a good result to valid", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: "ok", quality: "good", resultcode: 1 }));
    const provider = new MillionVerifierEmailVerificationProvider({ apiKey: "k", fetchImpl });
    const { outcomes } = await provider.verifyBatch(["a@example.com"]);
    expect(outcomes[0]?.code).toBe("valid");
  });

  it("maps an ok-but-risky-quality result to risky, never valid", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: "ok", quality: "risky", resultcode: 1 }));
    const provider = new MillionVerifierEmailVerificationProvider({ apiKey: "k", fetchImpl });
    const { outcomes } = await provider.verifyBatch(["a@example.com"]);
    expect(outcomes[0]?.code).toBe("risky");
  });

  it("maps invalid/catch_all/disposable results correctly", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: "invalid" }))
      .mockResolvedValueOnce(jsonResponse({ result: "catch_all" }))
      .mockResolvedValueOnce(jsonResponse({ result: "disposable" }));
    const provider = new MillionVerifierEmailVerificationProvider({ apiKey: "k", fetchImpl });
    const { outcomes } = await provider.verifyBatch(["a@x.com", "b@x.com", "c@x.com"]);
    expect(outcomes.map((o) => o.code)).toEqual(["invalid", "catch_all", "disposable"]);
  });

  it("never returns valid on a provider error or HTTP failure (outage safety)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "insufficient_credits" }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const provider = new MillionVerifierEmailVerificationProvider({ apiKey: "k", fetchImpl });
    const { outcomes, usage } = await provider.verifyBatch(["a@x.com", "b@x.com"]);
    expect(outcomes.every((o) => o.code === "unknown")).toBe(true);
    expect(usage.errors).toBe(2);
    expect(usage.costUsd).toBe(0);
  });
});
