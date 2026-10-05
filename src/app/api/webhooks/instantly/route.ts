import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { normalizeInstantlyInboundReply, normalizeInstantlyWebhook } from "@/infrastructure/providers/instantly/webhook-normalizer";
import { neonSetterInboundRuntimeStore, processInstantlyComplianceEvent, recordInstantlyIgnoredEvent } from "@/infrastructure/neon/repositories/setter-runtime";
import { getDeliveryEnv } from "@/lib/config/env";
import { processInstantlyInboundReply } from "@/services/setter/inbound-runtime";

export const dynamic = "force-dynamic";

function matchesWebhookSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const receivedHash = createHash("sha256").update(received).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export async function POST(request: Request) {
  const secret = getDeliveryEnv().INSTANTLY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Instantly webhook is not configured." }, { status: 503 });

  const rawBody = await request.text();
  if (!matchesWebhookSecret(request.headers.get("x-vitalcap-webhook-secret"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const root = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const nested = root?.data !== null && typeof root?.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : null;
  const eventType = nested?.event_type ?? root?.event_type;
  if (eventType !== "email_replied" && eventType !== "reply_received") {
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    if (eventType === "lead_unsubscribed" || eventType === "email_bounced") {
      const eventData = nested ?? root;
      const lead = record(eventData?.lead);
      const timestamp = firstString(eventData?.timestamp, eventData?.created_at, root?.timestamp);
      const occurredAt = timestamp ? new Date(timestamp) : new Date();
      const eventId = firstString(eventData?.event_id, root?.event_id, eventData?.webhook_event_id, eventData?.id, root?.id) ?? payloadHash;
      const statusEvent = normalizeInstantlyWebhook(payload, eventId, occurredAt);
      const email = firstString(eventData?.lead_email, eventData?.email, lead?.email, eventData?.from_email)?.toLowerCase();
      const campaignId = firstString(eventData?.campaign_id, eventData?.campaignId);
      if (!statusEvent || (statusEvent.code !== "bounced" && statusEvent.code !== "unsubscribed") || !email || !campaignId) {
        return NextResponse.json({ ok: true, ignored: true, eventType: String(eventType), errorCode: "INVALID_STATUS_PAYLOAD" }, { status: 202 });
      }
      const result = await processInstantlyComplianceEvent({
        providerEventId: statusEvent.providerEventId,
        providerMessageId: statusEvent.providerLeadId,
        providerCampaignId: campaignId,
        email,
        code: statusEvent.code,
        occurredAt: statusEvent.occurredAt,
        payloadHash,
      });
      return NextResponse.json({ ok: true, outcome: result.outcome, ...(result.errorCode ? { errorCode: result.errorCode } : {}) }, {
        status: result.outcome === "ignored_unknown_campaign" ? 202 : 200,
      });
    }
    const ignoredData = nested ?? root;
    const ignoredHash = createHash("sha256").update(rawBody).digest("hex");
    const ignoredEventId = firstString(ignoredData?.event_id, root?.event_id, ignoredData?.webhook_event_id, ignoredData?.id, root?.id) ?? ignoredHash;
    const ignoredMessageId = firstString(ignoredData?.email_id, ignoredData?.message_id, ignoredData?.lead_email, ignoredData?.email) ?? ignoredEventId;
    const ignoredCampaignId = firstString(ignoredData?.campaign_id, ignoredData?.campaignId);
    await recordInstantlyIgnoredEvent({
      eventType: typeof eventType === "string" ? eventType : "unknown",
      providerEventId: ignoredEventId,
      providerMessageId: ignoredMessageId,
      providerCampaignId: ignoredCampaignId,
      payloadHash: ignoredHash,
    });
    return NextResponse.json({ ok: true, ignored: true, eventType: typeof eventType === "string" ? eventType : "unknown" }, { status: 202 });
  }

  const event = normalizeInstantlyInboundReply(payload);
  if (!event) return NextResponse.json({ error: "Inbound reply is missing required event, message, campaign, email, or body fields." }, { status: 400 });

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  try {
    const result = await processInstantlyInboundReply(event, payloadHash, neonSetterInboundRuntimeStore);
    return NextResponse.json(
      { ok: true, outcome: result.outcome, ...(result.outcome === "human_required" ? { errorCode: result.failureCode } : {}) },
      { status: result.outcome === "ignored_unknown_campaign" ? 202 : 200 },
    );
  } catch {
    console.error("Instantly inbound Setter processing failed.");
    return NextResponse.json({ error: "Inbound reply was recorded but could not be resolved for Setter processing." }, { status: 422 });
  }
}