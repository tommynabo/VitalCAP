import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeInstantlyInboundReply = vi.fn();
const normalizeInstantlyWebhook = vi.fn();
const processInstantlyInboundReply = vi.fn();
const processInstantlyComplianceEvent = vi.fn();
const recordInstantlyIgnoredEvent = vi.fn();
const getDeliveryEnv = vi.fn();

vi.mock("@/infrastructure/providers/instantly/webhook-normalizer", () => ({ normalizeInstantlyInboundReply, normalizeInstantlyWebhook }));
vi.mock("@/infrastructure/neon/repositories/setter-runtime", () => ({ neonSetterInboundRuntimeStore: {}, processInstantlyComplianceEvent, recordInstantlyIgnoredEvent }));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv }));
vi.mock("@/services/setter/inbound-runtime", () => ({ processInstantlyInboundReply }));

const { POST } = await import("./route");
const secret = "test-webhook-secret-that-must-not-leak";
const replyPayload = {
  event_type: "reply_received",
  email_id: "reply-uuid-1",
  campaign_id: "campaign-1",
  lead_email: "lead@example.es",
  reply_text: "Please send details.",
};

function request(payload: unknown, header?: string) {
  return new Request("http://localhost/api/webhooks/instantly", {
    method: "POST",
    headers: header ? { "X-VitalCAP-Webhook-Secret": header } : {},
    body: JSON.stringify(payload),
  });
}

describe("POST /api/webhooks/instantly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeliveryEnv.mockReturnValue({ INSTANTLY_WEBHOOK_SECRET: secret });
    normalizeInstantlyInboundReply.mockReturnValue({ ...replyPayload, providerEventId: "reply-uuid-1" });
    normalizeInstantlyWebhook.mockImplementation((payload, providerEventId, occurredAt) => {
      const root = payload as { event_type?: string };
      return {
        providerLeadId: "lead@example.es",
        providerEventId,
        code: root.event_type === "email_bounced" ? "bounced" : "unsubscribed",
        occurredAt: occurredAt.toISOString(),
        raw: {},
      };
    });
    processInstantlyInboundReply.mockResolvedValue({ outcome: "processed" });
    processInstantlyComplianceEvent.mockResolvedValue({ outcome: "processed" });
    recordInstantlyIgnoredEvent.mockResolvedValue(undefined);
  });

  it.each([undefined, "wrong-secret"])("rejects missing or incorrect custom secret", async (header) => {
    const response = await POST(request(replyPayload, header));
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain(secret);
    expect(processInstantlyInboundReply).not.toHaveBeenCalled();
    expect(recordInstantlyIgnoredEvent).not.toHaveBeenCalled();
  });

  it("accepts the configured custom secret for a reply", async () => {
    const response = await POST(request(replyPayload, secret));

    expect(response.status).toBe(200);
    expect(normalizeInstantlyInboundReply).toHaveBeenCalledWith(replyPayload);
    expect(processInstantlyInboundReply).toHaveBeenCalledOnce();
    expect(await response.text()).not.toContain(secret);
  });

  it("acknowledges non-reply all-events payloads without invoking Setter", async () => {
    const response = await POST(request({ event_type: "email_opened" }, secret));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: true, eventType: "email_opened" });
    expect(normalizeInstantlyInboundReply).not.toHaveBeenCalled();
    expect(processInstantlyInboundReply).not.toHaveBeenCalled();
    expect(recordInstantlyIgnoredEvent).toHaveBeenCalledOnce();
  });

  it.each(["email_sent", "email_opened", "email_clicked", "campaign_completed"])("ignores %s without generating a Setter draft", async (eventType) => {
    const response = await POST(request({ event_type: eventType }, secret));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, ignored: true, eventType });
    expect(processInstantlyInboundReply).not.toHaveBeenCalled();
    expect(processInstantlyComplianceEvent).not.toHaveBeenCalled();
    expect(recordInstantlyIgnoredEvent).toHaveBeenCalledOnce();
  });

  it.each(["email_bounced", "lead_unsubscribed"])("routes %s to compliance suppression processing", async (eventType) => {
    const payload = { event_type: eventType, campaign_id: "campaign-1", lead_email: "lead@example.es" };
    const response = await POST(request(payload, secret));

    expect(response.status).toBe(200);
    expect(processInstantlyComplianceEvent).toHaveBeenCalledWith(expect.objectContaining({
      providerCampaignId: "campaign-1",
      email: "lead@example.es",
      code: eventType === "email_bounced" ? "bounced" : "unsubscribed",
    }));
    expect(processInstantlyInboundReply).not.toHaveBeenCalled();
  });

  it("acknowledges duplicate deliveries with 2xx", async () => {
    processInstantlyInboundReply.mockResolvedValue({ outcome: "duplicate_skipped" });
    const response = await POST(request(replyPayload, secret));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "duplicate_skipped" });
  });

  it("acknowledges replies from unmapped campaigns as ignored", async () => {
    processInstantlyInboundReply.mockResolvedValue({ outcome: "ignored_unknown_campaign" });
    const response = await POST(request(replyPayload, secret));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, outcome: "ignored_unknown_campaign" });
  });

  it("does not expose the configured secret in processing errors or logs", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    processInstantlyInboundReply.mockRejectedValue(new Error(secret));

    const response = await POST(request(replyPayload, secret));
    const responseText = await response.text();

    expect(response.status).toBe(422);
    expect(responseText).not.toContain(secret);
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(secret);
  });
});