import {
  EmailDeliveryProvider,
  EmailLeadInput,
  EmailLeadResult,
  EmailDeliveryStatusEvent,
  ProviderUsageStats,
  emptyProviderUsageStats
} from "@/domain/providers/types";
import { getCoreEnv, getDeliveryEnv } from "@/lib/config/env";

const INSTANTLY_API_BASE_URL = "https://api.instantly.ai/api/v2";

interface InstantlyAddLeadsResponse {
  status?: string;
  message?: string;
  leads_uploaded?: number;
  duplicated_leads?: number;
  skipped_count?: number;
  remaining_in_plan?: number | null;
  created_leads?: Array<{ id?: string; index?: number }>;
}

export interface InstantlyPlanUsage {
  currentLeadCount: number;
  totalLeadLimit: number;
}

export interface InstantlyMonthlyEmailUsage {
  emailsSent: number;
}

interface InstantlyPlanResponse {
  subscriptions?: {
    outreach?: { current_lead_count?: number; total_lead_limit?: number };
    bundle?: { current_lead_count?: number; total_lead_limit?: number };
  };
}

interface InstantlyCampaignAnalytics {
  emails_sent_count?: number;
}

function nonEmptyVariables(variables: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
}

/**
 * Real Instantly EmailDeliveryProvider.
 * Regular delivery respects DEFAULT_DELIVERY_MODE; explicit campaign imports
 * are separately opted in and never invoke a send endpoint.
 */
export class InstantlyEmailDeliveryProvider implements EmailDeliveryProvider {
  readonly providerName = "instantly";
  private apiKey: string | null;
  private fetchImpl: typeof fetch;
  private sleepImpl: (milliseconds: number) => Promise<void>;

  constructor(config: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    sleepImpl?: (milliseconds: number) => Promise<void>;
  } = {}) {
    const env = getDeliveryEnv();
    this.apiKey = config.apiKey ?? env.INSTANTLY_API_KEY ?? null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleepImpl = config.sleepImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private ensureConfigured() {
    if (!this.apiKey) {
      throw new Error("Instantly API key is not configured");
    }
  }

  async getPlanUsage(): Promise<InstantlyPlanUsage> {
    this.ensureConfigured();
    const response = await this.fetchImpl(`${INSTANTLY_API_BASE_URL}/workspace-billing/plan-details`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Instantly plan usage request failed: ${response.status}`);

    const data = await response.json() as InstantlyPlanResponse;
    const usage = data.subscriptions?.outreach ?? data.subscriptions?.bundle;
    const currentLeadCount = usage?.current_lead_count;
    const totalLeadLimit = usage?.total_lead_limit;
    if (!Number.isFinite(currentLeadCount) || !Number.isFinite(totalLeadLimit)) {
      throw new Error("Instantly plan usage response did not include lead usage and limit");
    }
    return { currentLeadCount: currentLeadCount!, totalLeadLimit: totalLeadLimit! };
  }

  async getMonthlyEmailUsage(now: Date): Promise<InstantlyMonthlyEmailUsage> {
    this.ensureConfigured();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const url = new URL(`${INSTANTLY_API_BASE_URL}/campaigns/analytics`);
    url.searchParams.set("start_date", monthStart.toISOString());
    url.searchParams.set("end_date", now.toISOString());
    url.searchParams.set("exclude_total_leads_count", "true");
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Instantly monthly usage request failed: ${response.status}`);

    const data = await response.json() as InstantlyCampaignAnalytics[];
    if (!Array.isArray(data) || data.some((campaign) => !Number.isFinite(campaign.emails_sent_count))) {
      throw new Error("Instantly monthly usage response did not include sent email counts");
    }
    return { emailsSent: data.reduce((total, campaign) => total + (campaign.emails_sent_count ?? 0), 0) };
  }

  async addLead(input: EmailLeadInput): Promise<{ result: EmailLeadResult; usage: ProviderUsageStats }> {
    this.ensureConfigured();
    const coreEnv = getCoreEnv();
    const isDryRun = coreEnv.DEFAULT_DELIVERY_MODE === "dry_run" && !input.allowCampaignImportInDryRun;
    const startedAt = Date.now();
    let data: InstantlyAddLeadsResponse | null = null;

    if (isDryRun) {
      data = {
        status: "success",
        message: "Lead uploaded successfully",
        leads_uploaded: 1,
        created_leads: [{ id: `dryrun_lead_${Date.now()}`, index: 0 }],
      };
    } else {
      let attempt = 0;
      const maxAttempts = 3;
      let lastError: Error | null = null;
      const variables = nonEmptyVariables(input.customVariables);
      const lead: Record<string, unknown> = { email: input.email.trim().toLowerCase() };
      const customVariables: Record<string, string> = {};
      const directFields = new Set(["first_name", "last_name", "company_name", "website", "phone", "job_title"]);

      for (const [key, value] of Object.entries(variables)) {
        if (directFields.has(key)) lead[key] = value;
        else customVariables[key] = value;
      }
      if (Object.keys(customVariables).length > 0) lead.custom_variables = customVariables;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          const payload = {
            campaign_id: input.providerCampaignId,
            leads: [lead],
            skip_if_in_workspace: input.skipIfExisting,
          };

          const response = await this.fetchImpl(`${INSTANTLY_API_BASE_URL}/leads/add`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
          });

          if (response.status === 429) {
            if (attempt === maxAttempts) throw new Error("Instantly API rate limit exceeded after retries");
            const waitTime = Math.pow(2, attempt) * 1000;
            await this.sleepImpl(waitTime);
            continue;
          }

          if (!response.ok) {
            lastError = new Error(`Instantly API error: ${response.status}`);
            if (response.status < 500) break;
            throw lastError;
          }

          data = await response.json() as InstantlyAddLeadsResponse;
          break; // success
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("Instantly request failed");
          if (attempt === maxAttempts) {
            throw lastError;
          }
        }
      }
    }

    if (!data) throw new Error("Instantly request completed without a response");

    const createdLead = data.created_leads?.[0];
    const wasAdded = (data.leads_uploaded ?? 0) > 0;
    const wasDuplicate = (data.duplicated_leads ?? 0) > 0 || (data.skipped_count ?? 0) > 0;
    if (!wasAdded && !wasDuplicate) {
      throw new Error("Instantly did not add the lead; it may have been blocked or rejected");
    }

    return {
      result: {
        providerLeadId: createdLead?.id ?? "existing_instantly_lead",
        status: wasAdded ? "added" : "skipped_existing",
      },
      usage: {
        calls: isDryRun ? 0 : 1,
        items: 1,
        errors: 0,
        totalLatencyMs: Date.now() - startedAt,
        costUsd: 0,
        quotaRemaining: data.remaining_in_plan ?? null,
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
