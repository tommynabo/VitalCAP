import { sql, type SQL } from "drizzle-orm";
import { MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS } from "@/services/autopilot/multi-niche-rollout";

export interface AdminScopedCandidateListOptions {
  workspaceId: string;
  campaignId?: string;
  stage?: string;
  limit: number;
}

export function buildAdminScopedCandidateListQuery(options: AdminScopedCandidateListOptions): SQL {
  const rolloutCampaignIds = sql.join(
    MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS.map((campaignId) => sql`${campaignId}::uuid`),
    sql`, `,
  );
  const campaignFilter = options.campaignId
    ? sql`AND raw.campaign_id = ${options.campaignId}::uuid`
    : sql``;
  const stageFilter = options.stage
    ? sql`AND membership.stage = ${options.stage}`
    : sql``;

  return sql`
    SELECT raw.id AS raw_candidate_id,
      raw.campaign_id,
      raw.processed,
      raw.discovered_at,
      raw.processing_metrics->'candidateOutcome'->>'businessType' AS business_type,
      raw.processing_metrics->'candidateOutcome'->>'physicalPresenceVerdict' AS physical_presence_verdict,
      raw.processing_metrics->'candidateOutcome'->>'icpQualified' AS icp_qualified,
      raw.processing_metrics->'candidateOutcome'->>'classifierVersion' AS classifier_version,
      raw.account_id,
      account.canonical_name,
      membership.stage AS membership_stage,
      COUNT(contact_point.id)::int AS contact_point_count,
      COUNT(contact_point.id) FILTER (WHERE contact_point.type = 'email')::int AS email_count,
      COUNT(contact_point.id) FILTER (WHERE contact_point.type = 'email' AND contact_point.verification_status = 'valid')::int AS valid_email_count
    FROM raw_candidates raw
    JOIN campaigns campaign ON campaign.id = raw.campaign_id
    LEFT JOIN accounts account ON account.id = raw.account_id
      AND account.workspace_id = campaign.workspace_id
    LEFT JOIN campaign_memberships membership ON membership.campaign_id = raw.campaign_id
      AND membership.account_id = raw.account_id
    LEFT JOIN contact_points contact_point ON contact_point.account_id = raw.account_id
      AND contact_point.workspace_id = campaign.workspace_id
    WHERE campaign.workspace_id = ${options.workspaceId}::uuid
      AND raw.campaign_id IN (${rolloutCampaignIds})
      ${campaignFilter}
      ${stageFilter}
    GROUP BY raw.id, account.canonical_name, membership.stage
    ORDER BY raw.discovered_at DESC, raw.id
    LIMIT ${Math.max(1, Math.min(20, Math.trunc(options.limit)))}
  `;
}