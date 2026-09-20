import { describe, expect, it } from "vitest";
import { MockEmailVerificationProvider } from "./mock-provider";

describe("MockEmailVerificationProvider", () => {
  it("returns a deterministic code for the same email", async () => {
    const provider = new MockEmailVerificationProvider();
    const first = await provider.verifyBatch(["info@farmaciadelgado.es"]);
    const second = await provider.verifyBatch(["info@farmaciadelgado.es"]);
    expect(first.outcomes[0]?.code).toBe(second.outcomes[0]?.code);
  });

  it("produces a spread of verification codes across many emails", async () => {
    const provider = new MockEmailVerificationProvider();
    const emails = Array.from({ length: 50 }, (_, i) => `contact${i}@example-${i}.es`);
    const { outcomes } = await provider.verifyBatch(emails);
    const codes = new Set(outcomes.map((o) => o.code));
    expect(codes.size).toBeGreaterThan(1);
  });

  it("tracks batch usage", async () => {
    const provider = new MockEmailVerificationProvider();
    const { usage } = await provider.verifyBatch(["a@x.es", "b@x.es"]);
    expect(usage.calls).toBe(1);
    expect(usage.items).toBe(2);
    expect(usage.costUsd).toBeGreaterThan(0);
  });
});
