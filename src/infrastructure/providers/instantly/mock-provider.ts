import type {
  EmailDeliveryProvider,
  EmailDeliveryStatusCode,
  EmailDeliveryStatusEvent,
  EmailLeadAddStatus,
  EmailLeadInput,
  EmailLeadResult,
} from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

/**
 * Development mock for `EmailDeliveryProvider`, shaped after Instantly's
 * "add lead to campaign" / "campaign status" concepts (Prompt 3 §3.3). No
 * real API is called and no campaign ID is ever hard-coded — the caller
 * always supplies `providerCampaignId` from configuration/DB. Deterministic
 * per-email outcomes reuse Phase 2's `hashString`/`seededRandom` fixture
 * pattern so tests and demos are stable but not uniform.
 */
export class MockInstantlyEmailDeliveryProvider implements EmailDeliveryProvider {
  readonly providerName = "mock-instantly";

  private readonly knownLeadIds = new Set<string>();

  async addLead(input: EmailLeadInput): ReturnType<EmailDeliveryProvider["addLead"]> {
    const providerLeadId = `instantly_lead_${hashString(`${input.providerCampaignId}:${input.email}`)}`;
    const status: EmailLeadAddStatus =
      input.skipIfExisting && this.knownLeadIds.has(providerLeadId) ? "skipped_existing" : "added";
    this.knownLeadIds.add(providerLeadId);

    const result: EmailLeadResult = { providerLeadId, status };
    return {
      result,
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 40, costUsd: 0, quotaRemaining: null },
    };
  }

  async syncStatus(providerCampaignId: string, since: Date): ReturnType<EmailDeliveryProvider["syncStatus"]> {
    const roll = seededRandom(hashString(`${providerCampaignId}:${since.toISOString()}`))();
    const code: EmailDeliveryStatusCode =
      roll > 0.97 ? "unsubscribed" : roll > 0.93 ? "bounced" : roll > 0.75 ? "replied" : roll > 0.4 ? "delivered" : "sent";

    const event: EmailDeliveryStatusEvent = {
      providerLeadId: `instantly_lead_${hashString(providerCampaignId)}`,
      providerEventId: `instantly_evt_${hashString(`${providerCampaignId}:${code}:${since.getTime()}`)}`,
      code,
      occurredAt: new Date().toISOString(),
      raw: { providerCampaignId, code },
    };

    return {
      events: [event],
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 50, costUsd: 0, quotaRemaining: null },
    };
  }
}
