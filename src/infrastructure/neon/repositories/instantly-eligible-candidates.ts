import { sql, type SQL } from "drizzle-orm";
import { actualPriorColdOutreachSql } from "./actual-outreach";
import { emailChannelEligibilitySql } from "@/services/compliance/email-channel-policy";

export interface InstantEligibleCandidateIdentityRow {
  workspace_id: string;
  account_id: string;
  source_campaign_id: string;
  contact_id: string | null;
  contact_point_id: string;
  normalized_email: string;
  verification_status: string;
  channel_eligibility: string;
}

export interface InstantEligibleCandidateRow extends InstantEligibleCandidateIdentityRow {
  canonical_name: string;
  website_url: string | null;
  normalized_domain: string | null;
  city: string | null;
  country_code: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
}

export interface InstantEligibleCandidateQueryOptions {
  providerCampaignId: string;
  workspaceId?: string;
  createdSince?: Date;
  rawDiscoveredWithin?: { start: Date; end: Date };
  contactPointIds?: readonly string[];
  backfillAll?: boolean;
  forEnqueue?: boolean;
  projection?: "candidate" | "identity";
  limit?: number | null;
}

export function buildInstantEligibleCandidatesQuery(options: InstantEligibleCandidateQueryOptions): SQL {
  const candidateScopeFilter = options.backfillAll
    ? sql``
    : options.contactPointIds && options.createdSince
      ? sql`AND (cp.id IN ${options.contactPointIds} OR cp.created_at >= ${options.createdSince.toISOString()})`
      : options.contactPointIds
        ? sql`AND cp.id IN ${options.contactPointIds}`
        : options.createdSince
          ? sql`AND cp.created_at >= ${options.createdSince.toISOString()}`
          : sql``;
  const workspaceFilter = options.workspaceId
    ? sql`AND c.workspace_id = ${options.workspaceId}::uuid`
    : sql``;
  const rawDiscoveryFilter = options.rawDiscoveredWithin
    ? sql`AND EXISTS (
        SELECT 1 FROM raw_candidates raw
        WHERE raw.campaign_id = cm.campaign_id
          AND raw.account_id = a.id
          AND raw.discovered_at >= ${options.rawDiscoveredWithin.start.toISOString()}::timestamptz
          AND raw.discovered_at < ${options.rawDiscoveredWithin.end.toISOString()}::timestamptz
      )`
    : sql``;
  const existingImportFilter = options.forEnqueue
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM instantly_lead_imports ili
        WHERE ili.workspace_id = a.workspace_id
          AND ili.account_id = a.id
          AND ili.provider_campaign_id = ${options.providerCampaignId}
      )`
    : sql``;
  const identityProjection = options.projection === "identity";
  const projection = identityProjection
    ? sql`a.workspace_id,
        a.id AS account_id,
        cm.campaign_id AS source_campaign_id,
        COALESCE(cp.contact_id, cm.contact_id) AS contact_id,
        cp.id AS contact_point_id,
        LOWER(TRIM(cp.normalized_value)) AS normalized_email,
        cp.verification_status,
        cp.channel_eligibility`
    : sql`a.workspace_id,
        a.id AS account_id,
        cm.campaign_id AS source_campaign_id,
        COALESCE(cp.contact_id, cm.contact_id) AS contact_id,
        cp.id AS contact_point_id,
        LOWER(TRIM(cp.normalized_value)) AS normalized_email,
        cp.verification_status,
        cp.channel_eligibility,
        a.canonical_name,
        a.website_url,
        a.normalized_domain,
        a.city,
        a.country_code,
        co.first_name,
        co.last_name,
        co.full_name`;
  const contactJoin = identityProjection
    ? sql``
    : sql`LEFT JOIN contacts co ON co.id = COALESCE(cp.contact_id, cm.contact_id)
        AND co.workspace_id = a.workspace_id`;
  const limit = options.limit === null
    ? sql``
    : options.limit === undefined || options.limit === 500
      ? sql`LIMIT 500`
      : sql`LIMIT ${options.limit}`;

  return sql`
    SELECT ${projection}
    FROM campaign_memberships cm
    JOIN campaigns c ON c.id = cm.campaign_id
    JOIN accounts a ON a.id = cm.account_id AND a.workspace_id = c.workspace_id
    JOIN contact_points cp ON cp.id = cm.selected_contact_point_id
      AND cp.account_id = a.id AND cp.workspace_id = a.workspace_id
    ${contactJoin}
    WHERE c.status = 'active'
      AND cm.stage = 'ready'
      AND cp.type = 'email'
      AND TRIM(cp.normalized_value) <> ''
      AND cp.verification_status = 'valid'
      AND ${emailChannelEligibilitySql(sql`cp.channel_eligibility`)}
      AND cp.last_contacted_at IS NULL
      AND cm.contacted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM compliance_decisions cd
        WHERE cd.workspace_id = a.workspace_id
          AND cd.campaign_id = cm.campaign_id
          AND cd.account_id = a.id
          AND cd.contact_point_id = cp.id
          AND cd.decision = 'allowed'
          AND cd.superseded_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM suppression_entries se
        WHERE se.workspace_id = a.workspace_id
          AND (se.account_id = a.id OR se.contact_point_id = cp.id)
      )
      AND NOT ${actualPriorColdOutreachSql({
        workspaceId: "a.workspace_id",
        accountId: "a.id",
        contactPointId: "cp.id",
        normalizedEmail: "cp.normalized_value",
      })}
      AND NOT EXISTS (
        SELECT 1 FROM conversations conv
        WHERE conv.workspace_id = a.workspace_id
          AND conv.account_id = a.id
          AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM meetings m
        JOIN conversations conv ON conv.id = m.conversation_id
        WHERE conv.workspace_id = a.workspace_id
          AND conv.account_id = a.id
      )
      ${workspaceFilter}
      ${rawDiscoveryFilter}
      ${candidateScopeFilter}
      ${existingImportFilter}
    ORDER BY cp.priority_score DESC, cp.created_at ASC
    ${limit}
  `;
}