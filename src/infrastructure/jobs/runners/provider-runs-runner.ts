import { listWorkspaceIds } from "@/infrastructure/neon/repositories/workspace";
import { getTodaySpendUsd } from "@/infrastructure/neon/repositories/provider-runs";
import { getServerEnv } from "@/lib/config/env";

const MONITORED_PROVIDERS = ["apify", "serper", "email_verification"] as const;

export interface ProviderRunsCheckResult {
  workspacesChecked: number;
  warnings: string[];
}

/**
 * Pure observability/audit check (§14 cost-guard) — recomputes today's real
 * spend per provider per workspace and flags any that exceed the only
 * configured daily limit (`APIFY_DAILY_COST_LIMIT_USD`; no equivalent env
 * var exists yet for Serper/MillionVerifier, so those are reported but
 * never compared against a threshold). No auto-pause action is taken and
 * no dashboard is wired — the outcome is persisted purely via `cron_runs`
 * (`status`/`error`/`itemsProcessed`) by the calling route. Real per-run
 * enforcement already happens at the provider-adapter composition root
 * before this cron ever runs; this is a second, independent audit pass.
 * Called once per `/api/cron/provider-runs` invocation.
 */
export async function runProviderRunsCronCheck(): Promise<ProviderRunsCheckResult> {
  const env = getServerEnv();
  const workspaceIds = await listWorkspaceIds();
  const warnings: string[] = [];

  for (const workspaceId of workspaceIds) {
    for (const provider of MONITORED_PROVIDERS) {
      const spend = await getTodaySpendUsd(workspaceId, provider);
      if (provider === "apify" && spend > env.APIFY_DAILY_COST_LIMIT_USD) {
        warnings.push(`workspace ${workspaceId}: apify today's spend $${spend.toFixed(2)} exceeds daily limit $${env.APIFY_DAILY_COST_LIMIT_USD.toFixed(2)}`);
      }
    }
  }

  return { workspacesChecked: workspaceIds.length, warnings };
}
