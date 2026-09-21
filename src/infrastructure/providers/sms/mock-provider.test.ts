import { describe, expect, it } from "vitest";
import { MockSmsDeliveryProvider } from "./mock-provider";

describe("MockSmsDeliveryProvider", () => {
  it("computes segments from body length and a positive cost", async () => {
    const provider = new MockSmsDeliveryProvider();
    const { result } = await provider.send({ fromSenderId: "sender_1", toE164: "+34611222333", body: "hola" });
    expect(result.segments).toBe(1);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("computes multiple segments for a long message body", async () => {
    const provider = new MockSmsDeliveryProvider();
    const longBody = "a".repeat(200);
    const { result } = await provider.send({ fromSenderId: "sender_1", toE164: "+34611222333", body: longBody });
    expect(result.segments).toBe(2);
  });

  it("syncStatus returns a deterministic status event", async () => {
    const provider = new MockSmsDeliveryProvider();
    const { events, usage } = await provider.syncStatus(new Date("2025-01-01T00:00:00Z"));
    expect(events).toHaveLength(1);
    expect(usage.calls).toBe(1);
  });
});
