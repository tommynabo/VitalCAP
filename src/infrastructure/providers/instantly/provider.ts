import { randomUUID } from "node:crypto";
import {
  EmailDeliveryProvider,
  EmailLeadInput,
  EmailLeadResult,
  EmailDeliveryStatusEvent,
  ProviderUsageStats,
  emptyProviderUsageStats
} from "@/domain/providers/types";
import { getCoreEnv, getDeliveryEnv } from "@/lib/config/env";
import { logEvent } from "@/lib/observability/structured-logger";

const INSTANTLY_API_BASE_URL = "https://api.instantly.ai/api/v2";

interface InstantlyAddLeadsResponse {
  status?: string;
  message?: string;
  total_sent?: number;
  leads_uploaded?: number;
  in_blocklist?: number;
  duplicated_leads?: number;
  skipped_count?: number;
  invalid_email_count?: number;
  incomplete_count?: number;
  duplicate_email_count?: number;
  remaining_in_plan?: number | null;
  created_leads?: Array<{ id?: string; index?: number }>;
}

export type InstantlyLeadImportStatus = "added" | "skipped_existing" | "failed";

export interface InstantlyLeadImportOutcome {
  index: number;
  status: InstantlyLeadImportStatus;
  providerLeadId: string | null;
  diagnostic: string | null;
}

type InstantlyEndpointCategory = "leads/add" | "workspace-billing/plan-details" | "campaigns/analytics";

export class InstantlyApiError extends Error {
  constructor(readonly details: {
    endpointCategory: InstantlyEndpointCategory;
    httpStatus: number | null;
    providerErrorCode: string | null;
    providerMessage: string | null;
    requestId: string;
  }) {
    const status = details.httpStatus === null ? "network" : String(details.httpStatus);
    super([
      `Instantly API request failed: endpoint=${details.endpointCategory}`,
      `http_status=${status}`,
      details.providerErrorCode ? `provider_code=${details.providerErrorCode}` : null,
      details.providerMessage ? `message=${details.providerMessage}` : null,
      `request_id=${details.requestId}`,
    ].filter(Boolean).join(" "));
    this.name = "InstantlyApiError";
  }
}

function sanitizeProviderText(value: unknown, apiKey: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 300);
}

function safeIdentifier(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 100) || null;
}

function leadPayload(input: EmailLeadInput): Record<string, unknown> {
  const variables = nonEmptyVariables(input.customVariables);
  const lead: Record<string, unknown> = { email: input.email.trim().toLowerCase() };
  const customVariables: Record<string, string> = {};
  const directFields = new Set(["first_name", "last_name", "company_name", "website", "phone", "job_title"]);

  for (const [key, value] of Object.entries(variables)) {
    if (directFields.has(key)) lead[key] = value;
    else customVariables[key] = value;
  }
  if (Object.keys(customVariables).length > 0) lead.custom_variables = customVariables;
  return lead;
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

  private createApiError(
    endpointCategory: InstantlyEndpointCategory,
    httpStatus: number | null,
    providerErrorCode: unknown,
    providerMessage: unknown,
    requestId: string,
  ): InstantlyApiError {
    const details = {
      endpointCategory,
      httpStatus,
      providerErrorCode: safeIdentifier(typeof providerErrorCode === "string" ? providerErrorCode : null),
      providerMessage: sanitizeProviderText(providerMessage, this.apiKey ?? ""),
      requestId: safeIdentifier(requestId) ?? randomUUID(),
    };
    logEvent("error", "Instantly API request failed", {
      correlationId: details.requestId,
      provider: "instantly",
      endpointCategory,
      httpStatus,
      providerErrorCode: details.providerErrorCode,
      providerMessage: details.providerMessage,
    });
    return new InstantlyApiError(details);
  }

  private async requestJson<T>(
    endpointCategory: InstantlyEndpointCategory,
    url: string | URL,
    init: RequestInit,
  ): Promise<{ data: T; requestId: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.createApiError(
        endpointCategory,
        null,
        "NETWORK_ERROR",
        error instanceof Error ? error.name : "Request failed",
        randomUUID(),
      );
    }

    const requestId = safeIdentifier(
      response.headers.get("x-request-id")
      ?? response.headers.get("request-id")
      ?? response.headers.get("x-correlation-id")
      ?? response.headers.get("traceparent"),
    ) ?? randomUUID();
    const responseText = await response.text();
    let data: unknown = null;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      if (response.ok) {
        throw this.createApiError(endpointCategory, response.status, "INVALID_JSON", "Provider returned a non-JSON response", requestId);
      }
    }

    if (!response.ok) {
      const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
      throw this.createApiError(
        endpointCategory,
        response.status,
        body.error_code ?? body.code,
        body.message ?? body.error ?? body.detail,
        requestId,
      );
    }
    return { data: data as T, requestId };
  }

  async getPlanUsage(): Promise<InstantlyPlanUsage> {
    this.ensureConfigured();
    const { data } = await this.requestJson<InstantlyPlanResponse>("workspace-billing/plan-details", `${INSTANTLY_API_BASE_URL}/workspace-billing/plan-details`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
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
    const { data } = await this.requestJson<InstantlyCampaignAnalytics[]>("campaigns/analytics", url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!Array.isArray(data) || data.some((campaign) => !Number.isFinite(campaign.emails_sent_count))) {
      throw new Error("Instantly monthly usage response did not include sent email counts");
    }
    return { emailsSent: data.reduce((total, campaign) => total + (campaign.emails_sent_count ?? 0), 0) };
  }

  async addLead(input: EmailLeadInput): Promise<{ result: EmailLeadResult; usage: ProviderUsageStats }> {
    const { outcomes, usage } = await this.addLeads([input]);
    const outcome = outcomes[0];
    if (!outcome || outcome.status === "failed") {
      throw new Error(outcome?.diagnostic ?? "Instantly leads/add did not return an outcome.");
    }
    return {
      result: {
        providerLeadId: outcome.providerLeadId ?? "existing_instantly_lead",
        status: outcome.status,
      },
      usage,
    };
  }

  async addLeads(inputs: readonly EmailLeadInput[]): Promise<{
    outcomes: InstantlyLeadImportOutcome[];
    usage: ProviderUsageStats;
  }> {
    this.ensureConfigured();
    if (inputs.length === 0 || inputs.length > 1000) {
      throw new RangeError("Instantly bulk imports require between 1 and 1000 leads.");
    }
    const providerCampaignId = inputs[0]!.providerCampaignId;
    if (inputs.some((input) => input.providerCampaignId !== providerCampaignId)) {
      throw new Error("Instantly bulk imports must target one campaign.");
    }

    const coreEnv = getCoreEnv();
    const isDryRun = coreEnv.DEFAULT_DELIVERY_MODE === "dry_run"
      && inputs.some((input) => !input.allowCampaignImportInDryRun);
    const startedAt = Date.now();
    if (isDryRun) {
      return {
        outcomes: inputs.map((_, index) => ({
          index,
          status: "added" as const,
          providerLeadId: `dryrun_lead_${Date.now()}_${index}`,
          diagnostic: null,
        })),
        usage: { calls: 0, items: inputs.length, errors: 0, totalLatencyMs: Date.now() - startedAt, costUsd: 0, quotaRemaining: null },
      };
    }

    let data: InstantlyAddLeadsResponse | null = null;
    let requestId: string = randomUUID();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.requestJson<InstantlyAddLeadsResponse>("leads/add", `${INSTANTLY_API_BASE_URL}/leads/add`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            campaign_id: providerCampaignId,
            skip_if_in_workspace: inputs.every((input) => input.skipIfExisting),
            verify_leads_on_import: false,
            leads: inputs.map(leadPayload),
          }),
          signal: AbortSignal.timeout(15_000),
        });
        data = response.data;
        requestId = response.requestId;
        break;
      } catch (error) {
        if (!(error instanceof InstantlyApiError) || (error.details.httpStatus !== 429 && (error.details.httpStatus ?? 0) < 500) || attempt === 3) {
          throw error;
        }
        await this.sleepImpl(2 ** attempt * 1000);
      }
    }

    if (!data) {
      throw this.createApiError("leads/add", null, "EMPTY_RESPONSE", "Bulk request completed without a response", requestId);
    }

    const createdLeads = data.created_leads ?? [];
    const createdCount = data.leads_uploaded ?? 0;
    const createdByIndex = new Map<number, string>();
    for (const lead of createdLeads) {
      if (!Number.isInteger(lead.index) || lead.index! < 0 || lead.index! >= inputs.length || !lead.id || createdByIndex.has(lead.index!)) {
        throw this.createApiError("leads/add", 200, "INVALID_BULK_RESPONSE", "Provider returned invalid created lead indices", requestId);
      }
      createdByIndex.set(lead.index!, lead.id);
    }
    if (createdByIndex.size !== createdCount || (data.total_sent !== undefined && data.total_sent !== inputs.length)) {
      throw this.createApiError("leads/add", 200, "INVALID_BULK_RESPONSE", "Provider bulk counts did not match the submitted batch", requestId);
    }

    const outcomes: InstantlyLeadImportOutcome[] = inputs.map((_, index) => {
      const providerLeadId = createdByIndex.get(index);
      return providerLeadId
        ? { index, status: "added", providerLeadId, diagnostic: null }
        : { index, status: "failed", providerLeadId: null, diagnostic: null };
    });
    const uncreated = outcomes.filter((outcome) => outcome.status === "failed");
    const skippedCount = (data.duplicated_leads ?? 0) + (data.skipped_count ?? 0);
    const rejectedCount = (data.in_blocklist ?? 0) + (data.invalid_email_count ?? 0) + (data.incomplete_count ?? 0);
    const duplicateRequestCount = data.duplicate_email_count ?? 0;
    const aggregateRejectedCount = rejectedCount + duplicateRequestCount;
    if (uncreated.length > 0 && skippedCount === uncreated.length && aggregateRejectedCount === 0) {
      for (const outcome of uncreated) outcome.status = "skipped_existing";
    } else if (uncreated.length > 0 && rejectedCount === uncreated.length && skippedCount === 0 && duplicateRequestCount === 0) {
      for (const outcome of uncreated) {
        outcome.diagnostic = `Instantly leads/add rejected a lead (blocklist=${data.in_blocklist ?? 0}, invalid=${data.invalid_email_count ?? 0}, incomplete=${data.incomplete_count ?? 0}).`;
      }
    } else if (uncreated.length > 0) {
      const diagnostic = `Instantly leads/add returned aggregate-only outcomes (uncreated=${uncreated.length}, duplicate_or_skipped=${skippedCount}, rejected=${aggregateRejectedCount}); individual results are ambiguous.`;
      for (const outcome of uncreated) outcome.diagnostic = diagnostic;
    }

    return {
      usage: {
        calls: 1,
        items: inputs.length,
        errors: outcomes.filter((outcome) => outcome.status === "failed").length,
        totalLatencyMs: Date.now() - startedAt,
        costUsd: 0,
        quotaRemaining: data.remaining_in_plan ?? null,
      },
      outcomes,
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
