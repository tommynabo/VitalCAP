import type { EmailVerificationProvider, MapsDiscoveryProvider, SerpDiscoveryProvider } from "@/domain/providers/types";
import { getServerEnv } from "@/lib/config/env";
import { MockMapsDiscoveryProvider } from "./maps/mock-provider";
import { ApifyMapsDiscoveryProvider } from "./maps/apify-provider";
import { MockSerpDiscoveryProvider } from "./serp/mock-provider";
import { SerperDiscoveryProvider } from "./serp/serper-provider";
import { MockEmailVerificationProvider } from "./email-verification/mock-provider";
import { MillionVerifierEmailVerificationProvider } from "./email-verification/millionverifier-provider";
import { getTodaySpendUsd, recordProviderRun } from "@/infrastructure/neon/repositories/provider-runs";

export type MapsEngineRole = "maps_fast" | "maps_deep" | "hybrid_fill";

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
  const env = getServerEnv();
  if (env.MAPS_PROVIDER === "mock") return new MockMapsDiscoveryProvider();

  if (!env.APIFY_API_TOKEN) {
    throw new Error("MAPS_PROVIDER=apify requires APIFY_API_TOKEN to be set.");
  }

  const actorId = role === "maps_fast" ? env.APIFY_MAPS_FAST_ACTOR : role === "maps_deep" ? env.APIFY_MAPS_DEEP_ACTOR : env.APIFY_MAPS_FALLBACK_ACTOR;

  return new ApifyMapsDiscoveryProvider({
    apiToken: env.APIFY_API_TOKEN,
    actorId,
    dailyCostLimitUsd: env.APIFY_DAILY_COST_LIMIT_USD,
    batchCostLimitUsd: env.APIFY_BATCH_COST_LIMIT_USD,
    getTodaySpendUsd: () => getTodaySpendUsd(workspaceId, "apify"),
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

export function createSerpDiscoveryProvider(workspaceId: string): SerpDiscoveryProvider {
  const env = getServerEnv();
  if (env.SERP_PROVIDER === "mock") return new MockSerpDiscoveryProvider();

  if (!env.SERPER_API_KEY) {
    throw new Error("SERP_PROVIDER=serper requires SERPER_API_KEY to be set.");
  }

  const provider = new SerperDiscoveryProvider({
    apiKey: env.SERPER_API_KEY,
    country: env.SERPER_COUNTRY,
    language: env.SERPER_LANGUAGE,
  });

  // Serper's cost is deterministic per call (flat per-query credit), so
  // usage is recorded fire-and-forget after the fact rather than gating the
  // call itself the way Apify's pre-run cost guard does.
  const originalSearch = provider.search.bind(provider);
  provider.search = async (input) => {
    const output = await originalSearch(input);
    if (output.usage.calls > 0) {
      void recordProviderRun({
        workspaceId,
        provider: "serper",
        operation: "search",
        status: "completed",
        itemsReturned: output.results.length,
        costUsd: output.usage.costUsd,
        metadata: { query: input.query },
      });
    }
    return output;
  };
  return provider;
}

export function createEmailVerificationProvider(workspaceId: string): EmailVerificationProvider {
  const env = getServerEnv();
  if (env.EMAIL_VERIFICATION_PROVIDER === "mock") return new MockEmailVerificationProvider();

  if (!env.MILLIONVERIFIER_API_KEY) {
    throw new Error("EMAIL_VERIFICATION_PROVIDER=millionverifier requires MILLIONVERIFIER_API_KEY to be set.");
  }

  const provider = new MillionVerifierEmailVerificationProvider({ apiKey: env.MILLIONVERIFIER_API_KEY });
  const originalVerifyBatch = provider.verifyBatch.bind(provider);
  provider.verifyBatch = async (emails) => {
    const output = await originalVerifyBatch(emails);
    void recordProviderRun({
      workspaceId,
      provider: "email_verification",
      operation: "verifyBatch",
      status: "completed",
      itemsRequested: emails.length,
      itemsReturned: output.outcomes.length,
      costUsd: output.usage.costUsd,
    });
    return output;
  };
  return provider;
}
