import type {
  SmsDeliveryProvider,
  SmsDeliveryStatusCode,
  SmsDeliveryStatusEvent,
  SmsSendInput,
  SmsSendResult,
} from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

/**
 * Development mock for `SmsDeliveryProvider` (Prompt 3 §3.5). No real SMS
 * gateway is called; segment count and cost are derived deterministically
 * from the message body so dry-run cost projections stay stable.
 */
export class MockSmsDeliveryProvider implements SmsDeliveryProvider {
  readonly providerName = "mock-sms";

  private readonly costPerSegmentUsd = 0.015;

  async send(input: SmsSendInput): ReturnType<SmsDeliveryProvider["send"]> {
    const segments = Math.max(1, Math.ceil(input.body.length / 160));
    const result: SmsSendResult = {
      providerMessageId: `sms_${hashString(`${input.fromSenderId}:${input.toE164}:${input.body}`)}`,
      segments,
      costUsd: Number((segments * this.costPerSegmentUsd).toFixed(4)),
    };

    return {
      result,
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 35, costUsd: result.costUsd, quotaRemaining: null },
    };
  }

  async syncStatus(since: Date): ReturnType<SmsDeliveryProvider["syncStatus"]> {
    const roll = seededRandom(hashString(`sms-status:${since.toISOString()}`))();
    const code: SmsDeliveryStatusCode =
      roll > 0.95 ? "opted_out" : roll > 0.9 ? "failed" : roll > 0.7 ? "replied" : "delivered";

    const event: SmsDeliveryStatusEvent = {
      providerMessageId: `sms_${hashString(since.toISOString())}`,
      providerEventId: `sms_evt_${hashString(`${code}:${since.getTime()}`)}`,
      code,
      failureCode: code === "failed" ? "carrier_rejected" : null,
      occurredAt: new Date().toISOString(),
      raw: { code },
    };

    return {
      events: [event],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 30, costUsd: 0, quotaRemaining: null },
    };
  }
}
