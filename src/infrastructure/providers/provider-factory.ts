import { computeProviderBudgetPacing, getElapsedOperatingFraction } from "@/services/autopilot/economic-pacing";
import { createHash } from "node:crypto";
import type { EmailVerificationProvider, MapsDiscoveryProvider, SerpDiscoveryProvider } from "@/domain/providers/types";
import type { EngineType } from "@/domain/campaigns/types";
import { ProviderBudgetExceededError, ProviderConfigurationError } from "@/domain/providers/errors";
import { getMapsEnv, getSerperEnv, getVerificationEnv } from "@/lib/config/env";
import { MockMapsDiscoveryProvider } from "./maps/mock-provider";
import { ApifyMapsDiscoveryProvider } from "./maps/apify-provider";
import { MockSerpDiscoveryProvider } from "./serp/mock-provider";
import { MAX_TRANSIENT_RETRIES, SERPER_ESTIMATED_COST_PER_QUERY_USD, SERPER_LINKEDIN_DAILY_EXPLORATION_LIMIT_USD, SerperDiscoveryProvider } from "./serp/serper-provider";
import { MockEmailVerificationProvider } from "./email-verification/mock-provider";
import { MillionVerifierEmailVerificationProvider, MILLIONVERIFIER_ESTIMATED_COST_PER_EMAIL_USD } from "./email-verification/millionverifier-provider";
import { getGlobalSerperSpendToday, getLatestProviderEconomicPacingStates, getProviderRunByRequestKey, getSerperRecoveryState, getTodaySpendUsd, recordProviderRun, reserveSerperProviderRun, updateProviderRun } from "@/infrastructure/neon/repositories/provider-runs";
import { getAutopilotSettings } from "@/infrastructure/neon/repositories/autopilot";
import { getEffectiveAutopilotState } from "@/domain/autopilot/types";
import { getDayBounds } from "@/lib/time/day-bounds";
import { createProviderRequestKey, currentProviderPlanningWindow, nextProviderPlanningWindowAt, normalizeProviderQuery } from "@/services/discovery/provider-request-key";
import { APIFY_DEFAULT_BATCH_COST_LIMIT_USD, APIFY_MAX_RESULTS_PER_SEARCH } from "@/services/discovery/apify-request-capacity";

export type MapsEngineRole = "maps_fast" | "maps_deep" | "hybrid_fill";
export type SerperPurpose = "google_serp_discovery" | "linkedin_owner_discovery" | "maps_fast_website_recovery" | "maps_deep_enrichment" | "recovery_probe";

function purposeForEngine(engineType: EngineType): SerperPurpose {
  if (engineType === "maps_fast") return "maps_fast_website_recovery";
  if (engineType === "maps_deep") return "maps_deep_enrichment";
  if (engineType === "google_serp") return "google_serp_discovery";
  if (engineType === "linkedin_owner") return "linkedin_owner_discovery";
  throw new ProviderConfigurationError("Serper purpose is not configured for this discovery engine.");
}

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
    throw new ProviderConfigurationError("MAPS_PROVIDER=apify requires APIFY_API_TOKEN to be set.");
  }

  const actorId = role === "maps_fast" ? (env.APIFY_MAPS_FAST_ACTOR || "compass/crawler-google-places") : role === "maps_deep" ? (env.APIFY_MAPS_DEEP_ACTOR || "compass/crawler-google-places") : (env.APIFY_MAPS_FALLBACK_ACTOR || "compass/crawler-google-places");

  return new ApifyMapsDiscoveryProvider({
    apiToken: env.APIFY_API_TOKEN,
    actorId,
    dailyCostLimitUsd: env.APIFY_DAILY_COST_LIMIT_USD,
    batchCostLimitUsd: Math.min(env.APIFY_BATCH_COST_LIMIT_USD, APIFY_DEFAULT_BATCH_COST_LIMIT_USD),
    maxCrawledPlacesPerSearch: APIFY_MAX_RESULTS_PER_SEARCH,
    getTodaySpendUsd: async (excludeRequestKey) => {
      const settings = await getAutopilotSettings(workspaceId);
      return getTodaySpendUsd(workspaceId, "apify", settings.timezone, new Date(), excludeRequestKey);
    },
    getBudgetRetryAt: async () => getDayBounds((await getAutopilotSettings(workspaceId)).timezone).end,
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

export function createSerpDiscoveryProvider(workspaceId: string, engineType: EngineType, campaignId: string, discoveryJobId?: string): SerpDiscoveryProvider {
  const env = getSerperEnv();
  if (env.SERP_PROVIDER === "disabled") throw new ProviderDisabledError("SERP_PROVIDER");
  if (env.SERP_PROVIDER === "mock") return new MockSerpDiscoveryProvider();

  const apiKey = env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error("SERP_PROVIDER=serper requires SERPER_API_KEY to be set.");
  }

  const provider = new SerperDiscoveryProvider({
    apiKey,
    country: env.SERPER_COUNTRY,
    language: env.SERPER_LANGUAGE,
  });

  const originalSearch = provider.search.bind(provider);
  provider.search = async (input) => {
    const settings = await getAutopilotSettings(workspaceId);
    const now = new Date();
    const [serperSpendToday, latestPacingStates] = await Promise.all([
      getGlobalSerperSpendToday(now, undefined, settings.timezone),
      getLatestProviderEconomicPacingStates(workspaceId, settings.timezone, now),
    ]);
    const economicPacing = computeProviderBudgetPacing({
      spendTodayUsd: serperSpendToday,
      dailyCapUsd: env.SERPER_DAILY_COST_LIMIT_USD,
      elapsedOperatingFraction: getElapsedOperatingFraction(
        settings.timezone,
        now,
        settings.operatingStartHour ?? 7,
        settings.operatingEndHour ?? 22,
      ),
      previousState: latestPacingStates.serper,
    });
    const recoveryState = await getSerperRecoveryState(now);
    if (recoveryState.allocationPaused && !recoveryState.recoveryProbeEligible) {
      throw new ProviderBudgetExceededError(
        "Serper allocation is paused during billing recovery cooldown.",
        recoveryState.nextRecoveryAttemptAt ?? new Date(now.getTime() + 60 * 60 * 1000),
      );
    }

    const recoveryProbe = recoveryState.allocationPaused && recoveryState.recoveryProbeEligible;
    const purpose = recoveryProbe ? "recovery_probe" : purposeForEngine(engineType);
    const query = input.query;
    const normalizedQuery = normalizeProviderQuery(query);
    const maxResults = recoveryProbe ? 1 : input.maxResults;
    const maxRetries = recoveryProbe ? 0 : MAX_TRANSIENT_RETRIES;
    const reserveCostUsd = (maxRetries + 1) * SERPER_ESTIMATED_COST_PER_QUERY_USD;
    const { start: dayStart } = getDayBounds(settings.timezone, now);
    const planningWindow = recoveryProbe
      ? `recovery:${Math.floor(now.getTime() / (60 * 60 * 1000))}`
      : dayStart.toISOString();
    const credentialFingerprint = createHash("sha256").update(apiKey).digest("hex");
    const requestQuery = recoveryProbe ? `serper-recovery-probe:${credentialFingerprint}` : normalizedQuery;
    const requestKey = createProviderRequestKey({
      workspaceId: recoveryProbe ? "serper-account" : workspaceId,
      campaignId: recoveryProbe ? "serper-recovery" : campaignId,
      engineType: recoveryProbe ? "recovery_probe" : engineType,
      provider: "serper",
      query: requestQuery,
      planningWindow,
      purpose,
      country: env.SERPER_COUNTRY ?? "es",
      language: env.SERPER_LANGUAGE ?? "es",
      maxResults,
    });
    const queryFingerprint = createHash("sha256").update(normalizedQuery).digest("hex");
    const requestMetadata = {
      engineType,
      purpose,
      queryFingerprint,
      credentialFingerprint,
      country: env.SERPER_COUNTRY ?? "es",
      language: env.SERPER_LANGUAGE ?? "es",
      maxResults,
      planningWindow,
      recoveryProbe,
      economicPaceState: economicPacing.state,
      ...(discoveryJobId ? { discoveryJobId } : {}),
    };
    const purposeLimitUsd = purpose === "linkedin_owner_discovery"
      ? Math.min(env.SERPER_DAILY_COST_LIMIT_USD * 0.05, SERPER_LINKEDIN_DAILY_EXPLORATION_LIMIT_USD)
      : purpose === "maps_deep_enrichment"
        ? env.SERPER_DAILY_COST_LIMIT_USD * 0.1
        : null;
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

    if (!recoveryProbe && economicPacing.state === "NEAR_DAILY_CAP") {
      throw new ProviderBudgetExceededError(
        "Serper allocation is paused near the daily budget cap.",
        getDayBounds(settings.timezone, now).end,
      );
    }

    const reservation = await reserveSerperProviderRun({
      workspaceId,
      campaignId,
      requestKey,
      seedId: input.seedId,
      itemsRequested: maxResults,
      costUsd: reserveCostUsd,
      dailyCostLimitUsd: env.SERPER_DAILY_COST_LIMIT_USD,
      ...(purposeLimitUsd === null ? {} : { purposeLimitUsd }),
      metadata: requestMetadata,
      timeZone: settings.timezone,
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

    let output;
    try {
      output = await originalSearch({ ...input, query, maxResults, maxRetries });
    } catch (error) {
      const errorKind = (error as { kind?: unknown })?.kind;
      const failureKind = typeof errorKind === "string"
        && ["billing", "authentication", "configuration", "transient", "rate_limit", "timeout", "unknown", "safety"].includes(errorKind)
        ? errorKind
        : "unknown";
      const httpAttempts = typeof (error as { httpAttempts?: unknown })?.httpAttempts === "number" ? (error as { httpAttempts: number }).httpAttempts : 0;
      const costUsd = typeof (error as { estimatedCostUsd?: unknown })?.estimatedCostUsd === "number"
        ? (error as { estimatedCostUsd: number }).estimatedCostUsd
        : ["billing", "authentication", "configuration"].includes(failureKind)
          ? 0
          : httpAttempts * SERPER_ESTIMATED_COST_PER_QUERY_USD;
      await updateProviderRun(reservation.providerRun.id, {
        status: "failed",
        itemsReturned: 0,
        costUsd,
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
        metadata: { ...requestMetadata, failureKind, httpAttempts },
      });
      throw error;
    }

    await updateProviderRun(reservation.providerRun.id, {
      status: "completed",
      itemsReturned: output.results.length,
      costUsd: output.usage.costUsd,
      finishedAt: new Date(),
      metadata: { ...requestMetadata, httpAttempts: output.usage.calls },
    });
    return { ...output, results: recoveryProbe ? [] : output.results, providerRunId: reservation.providerRun.id };
  };
  return provider;
}

export function createEmailVerificationProvider(workspaceId: string): EmailVerificationProvider {
  const env = getVerificationEnv();
  if (env.EMAIL_VERIFICATION_PROVIDER === "disabled") return disabledEmailVerificationProvider;
  if (env.EMAIL_VERIFICATION_PROVIDER === "mock") return new MockEmailVerificationProvider();

  const apiKey = env.MILLION_VERIFIER ?? env.MILLIONVERIFIER_API_KEY;
  if (!apiKey) {
    throw new Error("EMAIL_VERIFICATION_PROVIDER=millionverifier requires MILLION_VERIFIER to be set.");
  }

  const provider = new MillionVerifierEmailVerificationProvider({ apiKey });
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
