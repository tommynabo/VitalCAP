import type { EmailVerificationProvider, MapsDiscoveryProvider, SerpDiscoveryProvider } from "@/domain/providers/types";
import type { EngineType } from "@/domain/campaigns/types";
import { ProviderBudgetExceededError } from "@/domain/providers/errors";
import { getMapsEnv, getSerperEnv, getVerificationEnv } from "@/lib/config/env";
import { MockMapsDiscoveryProvider } from "./maps/mock-provider";
import { ApifyMapsDiscoveryProvider } from "./maps/apify-provider";
import { MockSerpDiscoveryProvider } from "./serp/mock-provider";
import { SerperDiscoveryProvider, SERPER_ESTIMATED_COST_PER_QUERY_USD } from "./serp/serper-provider";
import { MockEmailVerificationProvider } from "./email-verification/mock-provider";
import { MillionVerifierEmailVerificationProvider, MILLIONVERIFIER_ESTIMATED_COST_PER_EMAIL_USD } from "./email-verification/millionverifier-provider";
import { getProviderRunByRequestKey, getTodaySpendUsd, recordProviderRun, reserveSerperProviderRun, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getDayBounds } from "@/lib/time/day-bounds";
import { createProviderRequestKey, currentProviderPlanningWindow, nextProviderPlanningWindowAt, normalizeProviderQuery } from "@/services/discovery/provider-request-key";

export type MapsEngineRole = "maps_fast" | "maps_deep" | "hybrid_fill";

export class ProviderDisabledError extends Error {
  constructor(provider: string) {
    super(`Provider ${provider} is disabled and cannot be invoked.`);
    this.name = "ProviderDisabledError";
  }
}

const disabledEmailVerificationProvider: EmailVerificationProvider = {
  providerName: "disabled",
  verifyBatch: async () => ({
    outcomes: [],
    usage: { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null },
  }),
};

/**
 * Composition root for the discovery-provider interfaces (Prompt 7 §11–§20,
 * ADR-009). Reads `MAPS_PROVIDER` / `SERP_PROVIDER` /
 * `EMAIL_VERIFICATION_PROVIDER` from env and returns the interface-typed
 * concrete adapter — engines and services only ever see the domain
 * interface, never `Apify*`/`Serper*`/`MillionVerifier*` directly. This is
 * the one place in the codebase allowed to know both "which env var" and
 * "which concrete class".
 */
export function createMapsDiscoveryProvider(workspaceId: string, role: MapsEngineRole): MapsDiscoveryProvider {
  const env = getMapsEnv();
  if (env.MAPS_PROVIDER === "mock") return new MockMapsDiscoveryProvider();

  if (!env.APIFY_API_TOKEN) {
    throw new Error("MAPS_PROVIDER=apify requires APIFY_API_TOKEN to be set.");
  }

  const actorId = role === "maps_fast" ? (env.APIFY_MAPS_FAST_ACTOR || "compass/crawler-google-places") : role === "maps_deep" ? (env.APIFY_MAPS_DEEP_ACTOR || "compass/crawler-google-places") : (env.APIFY_MAPS_FALLBACK_ACTOR || "compass/crawler-google-places");

  return new ApifyMapsDiscoveryProvider({
    apiToken: env.APIFY_API_TOKEN,
    actorId,
    dailyCostLimitUsd: env.APIFY_DAILY_COST_LIMIT_USD,
    batchCostLimitUsd: env.APIFY_BATCH_COST_LIMIT_USD,
    getTodaySpendUsd: async () => {
      const settings = await getAutopilotSettings(workspaceId);
      return getTodaySpendUsd(workspaceId, "apify", settings.timezone);
    },
    getAutopilotState: async () => getEffectiveAutopilotState(await getAutopilotSettings(workspaceId)),
    getWorkspaceDailyCostLimitUsd: async () => (await getAutopilotSettings(workspaceId)).maxDailyApifySpendUsd,
    recordRun: (run) =>
      recordProviderRun({
        workspaceId,
        provider: "apify",
        operation: "maps_search",
        externalRunId: run.externalRunId,
        externalDatasetId: run.externalDatasetId,
        status: run.status,
        itemsRequested: run.itemsRequested,
        itemsReturned: run.itemsReturned,
        costUsd: run.costUsd,
        metadata: { actorId: run.actorId, errorMessage: run.errorMessage ?? null },
      }),
  });
}

export function createSerpDiscoveryProvider(workspaceId: string, engineType: EngineType, campaignId: string): SerpDiscoveryProvider {
  const env = getSerperEnv();
  if (env.SERP_PROVIDER === "disabled") throw new ProviderDisabledError("SERP_PROVIDER");
  if (env.SERP_PROVIDER === "mock") return new MockSerpDiscoveryProvider();

  if (!env.SERPER_API_KEY) {
    throw new Error("SERP_PROVIDER=serper requires SERPER_API_KEY to be set.");
  }

  const provider = new SerperDiscoveryProvider({
    apiKey: env.SERPER_API_KEY,
    country: env.SERPER_COUNTRY,
    language: env.SERPER_LANGUAGE,
  });

  const originalSearch = provider.search.bind(provider);
  provider.search = async (input) => {
    const settings = await getAutopilotSettings(workspaceId);
    const planningWindow = input.planningWindow ?? currentProviderPlanningWindow();
    const normalizedQuery = normalizeProviderQuery(input.query);
    const requestKey = createProviderRequestKey({ workspaceId, campaignId, engineType, provider: "serper", query: normalizedQuery, planningWindow });
    const existing = await getProviderRunByRequestKey(requestKey);
    if (existing) {
      if (existing.status === "budget_blocked") {
        const retryAt = new Date(String((existing.metadata as Record<string, unknown>).retryAt));
        throw new ProviderBudgetExceededError(existing.error ?? "Serper daily budget exhausted.", retryAt);
      }
      if (existing.status === "failed") throw new ProviderBudgetExceededError(existing.error ?? "Serper request failed in this planning window.", nextProviderPlanningWindowAt());
      if (existing.status === "starting") throw new ProviderBudgetExceededError("Serper request is already in progress for this planning window.", nextProviderPlanningWindowAt());
      return { results: [], usage: { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null }, providerRunId: existing.id };
    }

    const reservation = await reserveSerperProviderRun({
      workspaceId,
      campaignId,
      requestKey,
      seedId: input.seedId,
      itemsRequested: input.maxResults,
      costUsd: SERPER_ESTIMATED_COST_PER_QUERY_USD,
      metadata: { engineType, query: input.query, normalizedQuery, planningWindow },
    });
    if (!reservation.created) {
      if (reservation.providerRun.status === "budget_blocked") {
        const retryAt = new Date(String((reservation.providerRun.metadata as Record<string, unknown>).retryAt));
        throw new ProviderBudgetExceededError(reservation.providerRun.error ?? "Serper daily budget exhausted.", retryAt);
      }
      if (reservation.providerRun.status === "failed") throw new ProviderBudgetExceededError(reservation.providerRun.error ?? "Serper request failed in this planning window.", nextProviderPlanningWindowAt());
      if (reservation.providerRun.status === "starting") throw new ProviderBudgetExceededError("Serper request is already in progress for this planning window.", nextProviderPlanningWindowAt());
      return { results: [], usage: { calls: 0, items: 0, errors: 0, totalLatencyMs: 0, costUsd: 0, quotaRemaining: null }, providerRunId: reservation.providerRun.id };
    }

    const spendToday = await getTodaySpendUsd(workspaceId, "serper", settings.timezone);
    if (spendToday > env.SERPER_DAILY_COST_LIMIT_USD) {
      const { end: retryAt } = getDayBounds(settings.timezone);
      const message = `Serper daily budget exhausted; retrying after ${retryAt.toISOString()}.`;
      await updateProviderRun(reservation.providerRun.id, {
        status: "budget_blocked",
        costUsd: 0,
        finishedAt: new Date(),
        error: message,
        metadata: { engineType, query: input.query, normalizedQuery, planningWindow, retryAt: retryAt.toISOString(), budgetBlocked: true },
      });
      throw new ProviderBudgetExceededError(message, retryAt);
    }

    let output;
    try {
      output = await originalSearch(input);
    } catch (error) {
      await updateProviderRun(reservation.providerRun.id, {
        status: "failed",
        itemsReturned: 0,
        costUsd: 0,
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
        metadata: { engineType, query: input.query, normalizedQuery, planningWindow },
      });
      throw error;
    }

    await updateProviderRun(reservation.providerRun.id, {
      status: "completed",
      itemsReturned: output.results.length,
      costUsd: output.usage.costUsd,
      finishedAt: new Date(),
      metadata: { engineType, query: input.query, normalizedQuery, planningWindow },
    });
    return { ...output, providerRunId: reservation.providerRun.id };
  };
  return provider;
}

export function createEmailVerificationProvider(workspaceId: string): EmailVerificationProvider {
  const env = getVerificationEnv();
  if (env.EMAIL_VERIFICATION_PROVIDER === "disabled") return disabledEmailVerificationProvider;
  if (env.EMAIL_VERIFICATION_PROVIDER === "mock") return new MockEmailVerificationProvider();

  if (!env.MILLIONVERIFIER_API_KEY) {
    throw new Error("EMAIL_VERIFICATION_PROVIDER=millionverifier requires MILLIONVERIFIER_API_KEY to be set.");
  }

  const provider = new MillionVerifierEmailVerificationProvider({ apiKey: env.MILLIONVERIFIER_API_KEY });
  const originalVerifyBatch = provider.verifyBatch.bind(provider);
  provider.verifyBatch = async (emails) => {
    const settings = await getAutopilotSettings(workspaceId);
    const spendToday = await getTodaySpendUsd(workspaceId, "email_verification", settings.timezone);
    const estimatedCost = emails.length * MILLIONVERIFIER_ESTIMATED_COST_PER_EMAIL_USD;
    if (spendToday + estimatedCost > env.EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD) {
      const { end: retryAt } = getDayBounds(settings.timezone);
      const message = `Email verification daily cost limit reached; retrying after ${retryAt.toISOString()}.`;
      await recordProviderRun({
        workspaceId,
        provider: "email_verification",
        operation: "verifyBatch",
        status: "budget_blocked",
        itemsRequested: emails.length,
        itemsReturned: 0,
        costUsd: 0,
        error: message,
        metadata: { errors: 0, estimatedCostUsd: estimatedCost, dailyCostLimitUsd: env.EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD },
      });
      throw new ProviderBudgetExceededError(message, retryAt);
    }

    const output = await originalVerifyBatch(emails);
    try {
      await recordProviderRun({
        workspaceId,
        provider: "email_verification",
        operation: "verifyBatch",
        status: output.usage.errors > 0 ? "failed" : "completed",
        itemsRequested: emails.length,
        itemsReturned: output.outcomes.length,
        costUsd: output.usage.costUsd,
        error: output.usage.errors > 0 ? `${output.usage.errors} verification request(s) failed.` : null,
        metadata: {
          calls: output.usage.calls,
          items: output.usage.items,
          errors: output.usage.errors,
          totalLatencyMs: output.usage.totalLatencyMs,
          quotaRemaining: output.usage.quotaRemaining,
        },
      });
    } catch {
      // Metrics persistence must not cause a successful paid verification to be retried.
    }
    return output;
  };
  return provider;
}
