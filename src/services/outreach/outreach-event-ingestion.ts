import { createHmac, timingSafeEqual } from "node:crypto";
import type { OutreachEvent, OutreachEventState } from "@/domain/outreach/types";

/**
 * Outreach webhook ingestion (Prompt 3 §3.8). Two guarantees: (1) a
 * request whose signature does not match the shared secret is rejected
 * before any state changes, and (2) processing the exact same provider
 * event twice (retries, at-least-once delivery) never creates a duplicate
 * `OutreachEvent` — dedup key is `providerEventId`.
 */

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, sharedSecret: string): boolean {
  if (!signatureHeader) return false;
  const expectedHex = createHmac("sha256", sharedSecret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(signatureHeader, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export interface IngestOutreachEventInput {
  outreachQueueItemId: string;
  state: OutreachEventState;
  providerEventId: string;
  payloadHash: string | null;
  occurredAt: string;
}

export type IngestOutcome = "inserted" | "duplicate_skipped";

export interface IngestResult {
  events: OutreachEvent[];
  outcome: IngestOutcome;
  event: OutreachEvent;
}

/** Pure, replay-safe reducer over an event log; `generateId` is injected so tests stay deterministic. */
export function ingestOutreachEvent(
  existingEvents: readonly OutreachEvent[],
  input: IngestOutreachEventInput,
  generateId: () => string,
): IngestResult {
  const duplicate = existingEvents.find((event) => event.providerEventId === input.providerEventId);
  if (duplicate) {
    return { events: [...existingEvents], outcome: "duplicate_skipped", event: duplicate };
  }

  const newEvent: OutreachEvent = {
    id: generateId(),
    outreachQueueItemId: input.outreachQueueItemId,
    state: input.state,
    providerEventId: input.providerEventId,
    payloadHash: input.payloadHash,
    occurredAt: input.occurredAt,
  };
  return { events: [...existingEvents, newEvent], outcome: "inserted", event: newEvent };
}
