import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OutreachEvent } from "@/domain/outreach/types";
import { ingestOutreachEvent, verifyWebhookSignature } from "./outreach-event-ingestion";

describe("verifyWebhookSignature", () => {
  const secret = "shhh";
  const body = JSON.stringify({ hello: "world" });
  const validSignature = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correctly signed payload", () => {
    expect(verifyWebhookSignature(body, validSignature, secret)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    expect(verifyWebhookSignature(body + "x", validSignature, secret)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhookSignature(body, validSignature, "wrong-secret")).toBe(false);
  });
});

describe("ingestOutreachEvent", () => {
  const input = {
    outreachQueueItemId: "q_1",
    state: "delivered" as const,
    providerEventId: "prov_evt_1",
    payloadHash: null,
    occurredAt: "2025-01-01T00:00:00Z",
  };

  it("inserts a new event when the providerEventId has not been seen before", () => {
    const result = ingestOutreachEvent([], input, () => "ev_1");
    expect(result.outcome).toBe("inserted");
    expect(result.events).toHaveLength(1);
  });

  it("is idempotent: replaying the same providerEventId does not duplicate the event", () => {
    const first = ingestOutreachEvent([], input, () => "ev_1");
    const second = ingestOutreachEvent(first.events, input, () => "ev_2");
    expect(second.outcome).toBe("duplicate_skipped");
    expect(second.events).toHaveLength(1);
    expect(second.event.id).toBe("ev_1");
  });

  it("treats different providerEventIds as distinct events", () => {
    const existing: OutreachEvent[] = [
      { id: "ev_1", outreachQueueItemId: "q_1", state: "sent", providerEventId: "prov_evt_1", payloadHash: null, occurredAt: "2025-01-01T00:00:00Z" },
    ];
    const result = ingestOutreachEvent(existing, { ...input, providerEventId: "prov_evt_2" }, () => "ev_2");
    expect(result.outcome).toBe("inserted");
    expect(result.events).toHaveLength(2);
  });
});
