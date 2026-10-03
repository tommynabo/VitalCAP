import { describe, expect, it } from "vitest";
import { normalizeInstantlyInboundReply } from "./webhook-normalizer";

describe("normalizeInstantlyInboundReply", () => {
  const payload = {
    event_type: "email_replied",
    event_id: "evt-1",
    message_id: "msg-1",
    campaign_id: "external-campaign-1",
    lead_email: "Owner@Example.es",
    reply_text: "We are interested",
    timestamp: "2026-10-03T10:00:00.000Z",
  };

  it("normalizes inbound reply identifiers and content", () => {
    expect(normalizeInstantlyInboundReply(payload)).toEqual({
      providerEventId: "evt-1",
      providerMessageId: "msg-1",
      providerThreadId: "external-campaign-1:owner@example.es",
      providerCampaignId: "external-campaign-1",
      email: "owner@example.es",
      subject: "",
      body: "We are interested",
      occurredAt: "2026-10-03T10:00:00.000Z",
    });
  });

  it("rejects non-reply events and payloads missing idempotency identifiers", () => {
    expect(normalizeInstantlyInboundReply({ ...payload, event_type: "email_opened" })).toBeNull();
    expect(normalizeInstantlyInboundReply({ ...payload, message_id: undefined })).toBeNull();
    expect(normalizeInstantlyInboundReply({ ...payload, event_id: undefined })).toBeNull();
  });

  it("supports nested reply payloads and bounds no identifiers by guessing", () => {
    const normalized = normalizeInstantlyInboundReply({
      event_type: "email_replied",
      data: {
        event_id: "evt-2",
        email_id: "msg-2",
        campaign: { id: "external-campaign-2" },
        lead: { email: "lead@example.es" },
        reply: { text: "Hola", thread_id: "thread-2" },
      },
    });
    expect(normalized?.providerThreadId).toBe("thread-2");
    expect(normalized?.body).toBe("Hola");
  });
});