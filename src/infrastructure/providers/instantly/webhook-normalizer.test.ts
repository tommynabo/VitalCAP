import { describe, expect, it } from "vitest";
import { normalizeInstantlyInboundReply, normalizeInstantlyWebhook } from "./webhook-normalizer";

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
      eventType: "email_replied",
      providerEventId: "evt-1",
      providerMessageId: "msg-1",
      providerThreadId: "external-campaign-1:owner@example.es",
      providerCampaignId: "external-campaign-1",
      email: "owner@example.es",
      subject: "",
      body: "We are interested",
      occurredAt: "2026-10-03T10:00:00.000Z",
      emailAccount: null,
      workspace: null,
      campaignName: null,
    });
  });

  it("rejects non-reply events and payloads missing the provider reply identifier", () => {
    expect(normalizeInstantlyInboundReply({ ...payload, event_type: "email_opened" })).toBeNull();
    expect(normalizeInstantlyInboundReply({ ...payload, message_id: undefined })).toBeNull();
    expect(normalizeInstantlyInboundReply({ ...payload, event_id: undefined })?.providerEventId).toBe("msg-1");
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

  it.each(["reply_received", "email_replied"])("normalizes FlowNex fields for flat and nested %s payloads", (eventType) => {
    const flowNexFields = {
      event_type: eventType,
      email_id: "reply-uuid-1",
      lead_email: "Lead@Example.es",
      email_account: "sender@example.es",
      reply_subject: "Re: Pharmacy offer",
      reply_text: "Please send details.",
      campaign_id: "campaign-1",
      campaign_name: "Pharmacy outreach",
      workspace: "workspace-1",
      timestamp: "2026-10-04T12:30:00.000Z",
    };
    const expected = {
      providerEventId: "reply-uuid-1",
      providerMessageId: "reply-uuid-1",
      providerCampaignId: "campaign-1",
      email: "lead@example.es",
      emailAccount: "sender@example.es",
      subject: "Re: Pharmacy offer",
      body: "Please send details.",
      workspace: "workspace-1",
      campaignName: "Pharmacy outreach",
    };

    expect(normalizeInstantlyInboundReply(flowNexFields)).toMatchObject(expected);
    expect(normalizeInstantlyInboundReply({ event_type: eventType, data: flowNexFields })).toMatchObject(expected);
  });
});

describe("normalizeInstantlyWebhook", () => {
  it.each(["email_bounced", "lead_unsubscribed"])("normalizes nested %s status events", (eventType) => {
    expect(normalizeInstantlyWebhook({
      event_type: eventType,
      data: { lead_email: "Lead@Example.es" },
    }, "event-1", new Date("2026-10-04T12:30:00.000Z"))).toMatchObject({
      providerLeadId: "Lead@Example.es",
      providerEventId: "event-1",
      code: eventType === "email_bounced" ? "bounced" : "unsubscribed",
    });
  });

  it("ignores events outside the known provider status vocabulary", () => {
    expect(normalizeInstantlyWebhook({ event_type: "campaign_completed", lead_email: "lead@example.es" }, "event-1", new Date())).toBeNull();
  });
});