import {
  EmailDeliveryProvider,
  EmailLeadInput,
  EmailLeadResult,
  EmailDeliveryStatusEvent,
  ProviderUsageStats,
  emptyProviderUsageStats
} from "@/domain/providers/types";
import { getCoreEnv, getDeliveryEnv } from "@/lib/config/env";

/**
 * Real Instantly EmailDeliveryProvider.
 * Activation-ready, but actual fetching happens only if DEFAULT_DELIVERY_MODE is live.
 */
export class InstantlyEmailDeliveryProvider implements EmailDeliveryProvider {
  readonly providerName = "instantly";
  private apiKey: string | null;

  constructor() {
    const env = getDeliveryEnv();
    this.apiKey = env.INSTANTLY_API_KEY || null;
  }

  private ensureConfigured() {
    if (!this.apiKey) {
      throw new Error("Instantly API key is not configured");
    }
  }

  async addLead(input: EmailLeadInput): Promise<{ result: EmailLeadResult; usage: ProviderUsageStats }> {
    this.ensureConfigured();
    const coreEnv = getCoreEnv();
    
    let data: any;

    if (coreEnv.DEFAULT_DELIVERY_MODE === "dry_run") {
      data = {
        status: "success",
        message: "Lead uploaded successfully",
        leads: [
          {
            email: input.email,
            lead_id: `dryrun_lead_${Date.now()}`,
            custom_variables: input.customVariables
          }
        ]
      };
      // Skip the network IO completely, just use the mocked response data
    } else {
      const start = Date.now();
      let attempt = 0;
      const maxAttempts = 3;
      let lastError: Error | null = null;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          const payload = {
            api_key: this.apiKey,
            campaign_id: input.providerCampaignId,
            skip_if_in_workspace: input.skipIfExisting,
            leads: [
              {
                email: input.email,
                ...input.customVariables
              }
            ]
          };

          const response = await fetch("https://api.instantly.ai/api/v1/lead/add", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });

          if (response.status === 429) {
            // Rate limited, wait and retry
            const waitTime = Math.pow(2, attempt) * 1000;
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }

          if (!response.ok) {
            const body = await response.text();
            throw new Error(`Instantly API error: ${response.status} ${body}`);
          }

          data = await response.json();
          break; // success
        } catch (err: any) {
          lastError = err;
          if (attempt === maxAttempts) {
            throw lastError || new Error("Failed to add lead to Instantly after retries");
          }
        }
      }
    }

    // Response format typically: { status: "success", leads: [{ email: "...", lead_id: "..." }] }
    // Or if existing, might return different info based on skip_if_in_workspace
    const leadId = data?.leads?.[0]?.lead_id || `unknown_instantly_id_${Date.now()}`;
    
    // Since skip_if_in_workspace is boolean on input, we try to detect skipped.
    const status = data.message?.toLowerCase().includes("skipped") ? "skipped_existing" : "added";

    return {
      result: {
        providerLeadId: leadId,
        status: status as any
      },
      usage: {
        calls: coreEnv.DEFAULT_DELIVERY_MODE === "dry_run" ? 0 : 1,
        items: 1,
        errors: 0,
        totalLatencyMs: 0,
        costUsd: 0,
        quotaRemaining: null
      }
    };
  }

  async syncStatus(providerCampaignId: string, since: Date): Promise<{ events: EmailDeliveryStatusEvent[]; usage: ProviderUsageStats }> {
    // Instantly's pulling API is limited. Usually webhooks are preferred.
    // As per prompt, webhook normalization will handle incoming events.
    // For syncStatus, we can just return empty or mock if live is not enabled.
    return {
      events: [],
      usage: emptyProviderUsageStats()
    };
  }
}
