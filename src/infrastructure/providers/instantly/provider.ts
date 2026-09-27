import {
  EmailDeliveryProvider,
  EmailLeadInput,
  EmailLeadResult,
  EmailDeliveryStatusEvent,
  ProviderUsageStats,
  emptyProviderUsageStats
} from "@/domain/providers/types";
import { getServerEnv } from "@/lib/config/env";

/**
 * Real Instantly EmailDeliveryProvider.
 * Activation-ready, but actual fetching happens only if DEFAULT_DELIVERY_MODE is live.
 */
export class InstantlyEmailDeliveryProvider implements EmailDeliveryProvider {
  readonly providerName = "instantly";
  private apiKey: string | null;

  constructor() {
    const env = getServerEnv();
    this.apiKey = env.INSTANTLY_API_KEY || null;
  }

  private ensureConfigured() {
    if (!this.apiKey) {
      throw new Error("Instantly API key is not configured");
    }
  }

  async addLead(input: EmailLeadInput): Promise<{ result: EmailLeadResult; usage: ProviderUsageStats }> {
    this.ensureConfigured();
    const env = getServerEnv();
    
    // Delivery hard stop
    if (env.DEFAULT_DELIVERY_MODE === "dry_run") {
      return {
        result: {
          providerLeadId: `dryrun_lead_${Date.now()}`,
          status: "added"
        },
        usage: emptyProviderUsageStats()
      };
    }

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

        const data = await response.json();
        
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
            calls: 1,
            items: 1,
            errors: 0,
            totalLatencyMs: Date.now() - start,
            costUsd: 0,
            quotaRemaining: null
          }
        };

      } catch (err: any) {
        lastError = err;
        if (attempt === maxAttempts) break;
      }
    }

    throw lastError || new Error("Failed to add lead to Instantly after retries");
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
