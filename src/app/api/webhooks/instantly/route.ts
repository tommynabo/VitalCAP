import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { normalizeInstantlyInboundReply } from "@/infrastructure/providers/instantly/webhook-normalizer";
import { neonSetterInboundRuntimeStore } from "@/infrastructure/neon/repositories/setter-runtime";
import { getDeliveryEnv } from "@/lib/config/env";
import { verifyWebhookSignature } from "@/services/setter/reply-ingestion";
import { processInstantlyInboundReply } from "@/services/setter/inbound-runtime";

export const dynamic = "force-dynamic";

function signatureHeader(request: Request): string | null {
  const value = request.headers.get("x-instantly-signature") ?? request.headers.get("x-webhook-signature");
  return value?.replace(/^sha256=/i, "") ?? null;
}

export async function POST(request: Request) {
  const secret = getDeliveryEnv().INSTANTLY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Instantly webhook is not configured." }, { status: 503 });

  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, signatureHeader(request), secret)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
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
  if (eventType !== "email_replied") return NextResponse.json({ ok: true, ignored: true }, { status: 202 });

  const event = normalizeInstantlyInboundReply(payload);
  if (!event) return NextResponse.json({ error: "Inbound reply is missing required event, message, campaign, email, or body fields." }, { status: 400 });

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  try {
    const result = await processInstantlyInboundReply(event, payloadHash, neonSetterInboundRuntimeStore);
    return NextResponse.json({ ok: true, outcome: result.outcome }, { status: 200 });
  } catch {
    console.error("Instantly inbound Setter processing failed.");
    return NextResponse.json({ error: "Inbound reply was recorded but could not be resolved for Setter processing." }, { status: 422 });
  }
}