import { sql } from "drizzle-orm";
import { getAccountById, updateAccountFields } from "@/infrastructure/neon/repositories/accounts";
import { upsertCampaignMembership } from "@/infrastructure/neon/repositories/campaigns";
import { insertWebsiteEvidence } from "@/infrastructure/neon/repositories/enrichment";
import { getDb } from "@/infrastructure/neon/db";
import { realWebsiteFetcher } from "@/infrastructure/jobs/runners/engine-factory";
import { evaluateStructuredWebsiteLocation } from "@/infrastructure/jobs/runners/processing-runner";
import { WebsiteEnrichmentService } from "@/services/enrichment/website-enrichment-service";

const COHORT_START = new Date("2026-10-10T14:45:35.187Z");
const MAX_COHORT_ACCOUNTS = 11;

interface CohortAccount {
  account_id: string;
  workspace_id: string;
  campaign_id: string | null;
  campaign_count: number;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await getDb().execute(sql`
    SELECT
      account.id AS account_id,
      account.workspace_id,
      (array_agg(DISTINCT membership.campaign_id))[1] AS campaign_id,
      COUNT(DISTINCT membership.campaign_id)::int AS campaign_count
    FROM accounts account
    JOIN campaign_memberships membership ON membership.account_id = account.id
    WHERE account.status = 'needs_review'
      AND membership.stage = 'discovered'
      AND account.website_url IS NOT NULL
      AND account.normalized_domain IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM account_sources source
        WHERE source.account_id = account.id
          AND source.source_type = 'google_serp'
      )
      AND EXISTS (
        SELECT 1
        FROM contact_points point
        WHERE point.account_id = account.id
          AND point.type = 'email'
          AND point.source_type IN ('website_enrichment', 'serper_snippet')
          AND point.created_at >= ${COHORT_START.toISOString()}
      )
    GROUP BY account.id, account.workspace_id
    ORDER BY account.id
  `);
  const accounts = rows.rows.map((row): CohortAccount => ({
    account_id: String(row.account_id),
    workspace_id: String(row.workspace_id),
    campaign_id: typeof row.campaign_id === "string" ? row.campaign_id : null,
    campaign_count: Number(row.campaign_count),
  }));

  if (accounts.length > MAX_COHORT_ACCOUNTS) {
    throw new Error(`Refusing to process ${accounts.length} accounts; audited cohort limit is ${MAX_COHORT_ACCOUNTS}.`);
  }

  const ambiguousMemberships = accounts.filter((account) => account.campaign_count !== 1).length;
  console.info(JSON.stringify({
    mode: apply ? "apply" : "dry_run",
    cohortStart: COHORT_START.toISOString(),
    accountsSelected: accounts.length,
    ambiguousMemberships,
  }));
  if (!apply) return;

  const summary = { crawled: 0, crawlFailures: 0, evidencePersisted: 0, verified: 0, rejected: 0, stillNeedsReview: 0, skipped: 0 };
  const service = new WebsiteEnrichmentService(realWebsiteFetcher);

  for (const candidate of accounts) {
    if (candidate.campaign_count !== 1 || !candidate.campaign_id) {
      summary.skipped++;
      continue;
    }

    const account = await getAccountById(candidate.account_id);
    if (!account || account.status !== "needs_review" || !account.websiteUrl || !account.normalizedDomain) {
      summary.skipped++;
      continue;
    }

    const result = await service.enrich({
      workspaceId: candidate.workspace_id,
      accountId: candidate.account_id,
      websiteUrl: account.websiteUrl,
    });
    if (result.status !== "completed") {
      summary.crawlFailures++;
      continue;
    }
    summary.crawled++;

    const locationFacts = result.evidence.filter((fact) => fact.evidenceType.startsWith("location_"));
    for (const fact of locationFacts) {
      await insertWebsiteEvidence({
        workspaceId: candidate.workspace_id,
        accountId: candidate.account_id,
        normalizedDomain: account.normalizedDomain,
        sourceUrl: fact.sourceUrl,
        evidenceType: fact.evidenceType,
        value: fact.value,
        normalizedValue: fact.normalizedValue ?? fact.value,
        snippet: fact.snippet,
        contentHash: result.contentHash ?? "",
      });
      summary.evidencePersisted++;
    }

    const reevaluation = evaluateStructuredWebsiteLocation(account, locationFacts, account.normalizedDomain);
    if (reevaluation.verdict.verdict === "needs_review") {
      summary.stillNeedsReview++;
      continue;
    }

    await updateAccountFields(candidate.account_id, {
      ...reevaluation.accountUpdates,
      status: reevaluation.verdict.verdict === "verified" ? "no_contact_found" : "rejected_country",
    });
    await upsertCampaignMembership({
      campaignId: candidate.campaign_id,
      accountId: candidate.account_id,
      stage: reevaluation.verdict.verdict === "verified" ? "qualified" : "rejected",
      rejectionReason: reevaluation.verdict.verdict === "rejected"
        ? `Rejected: ${reevaluation.verdict.reason}`
        : null,
    });
    if (reevaluation.verdict.verdict === "verified") summary.verified++;
    else summary.rejected++;
  }

  console.info(JSON.stringify(summary));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Forward Spain evidence replay failed.");
  process.exitCode = 1;
});