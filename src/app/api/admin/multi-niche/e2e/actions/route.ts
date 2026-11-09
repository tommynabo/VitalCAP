import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { actualPriorColdOutreachSql } from "@/infrastructure/neon/repositories/actual-outreach";
import { getRawCandidateById } from "@/infrastructure/neon/repositories/discovery";
import { getCampaignById } from "@/infrastructure/neon/repositories/campaigns";
import { getDb } from "@/infrastructure/neon/db";
import { enqueueAdminScopedProcessingJob } from "@/infrastructure/neon/repositories/job-queue";
import { getScopedDraftInstantlyImportTarget } from "@/infrastructure/neon/repositories/instantly-import-targets";
import { runProcessingCronTick } from "@/infrastructure/jobs/runners/processing-runner";
import { runVerificationCronTick } from "@/infrastructure/jobs/runners/verification-runner";
import { runAdminScopedDraftInstantlyImport } from "@/infrastructure/jobs/runners/instantly-import-runner";
import { requireWorkspaceAdmin, UnauthorizedError } from "@/lib/auth/workspace";
import { AUTO_SEND_ENABLED } from "@/services/setter/autonomy-policy";
import { getMultiNicheRolloutEntry } from "@/services/autopilot/multi-niche-rollout";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("process"),
    campaignId: z.uuid(),
    rawCandidateId: z.uuid(),
    executionId: z.uuid(),
  }).strict(),
  z.object({
    action: z.literal("verify"),
    campaignId: z.uuid(),
    contactPointId: z.uuid(),
  }).strict(),
  z.object({
    action: z.literal("import"),
    campaignId: z.uuid(),
    contactPointId: z.uuid(),
  }).strict(),
]);

async function validateCampaign(campaignId: string, workspaceId: string) {
  const rollout = getMultiNicheRolloutEntry(campaignId);
  if (!rollout) return { response: NextResponse.json({ error: "Campaign ID is not allowlisted." }, { status: 403 }) };

  const campaign = await getCampaignById(campaignId);
  if (!campaign || campaign.workspaceId !== workspaceId) {
    return { response: NextResponse.json({ error: "Campaign was not found in the current workspace." }, { status: 404 }) };
  }
  if (campaign.status !== "draft" || campaign.autopilotEnabled || campaign.engineConfig?.niche !== rollout.niche) {
    return { response: NextResponse.json({ error: "Campaign must remain Draft, autopilot-off, and match the rollout niche." }, { status: 409 }) };
  }
  if (AUTO_SEND_ENABLED) {
    return { response: NextResponse.json({ error: "Admin E2E is blocked while auto-send is enabled." }, { status: 409 }) };
  }

  const target = await getScopedDraftInstantlyImportTarget(campaignId, workspaceId);
  if (!target.target) {
    return { response: NextResponse.json({ error: "Persisted disabled mapping preflight failed.", reason: target.blockReason }, { status: 409 }) };
  }
  return { campaign, target: target.target };
}

async function hasExactSelectedContactPoint(input: {
  campaignId: string;
  workspaceId: string;
  contactPointId: string;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT cp.id
    FROM contact_points cp
    JOIN campaign_memberships cm ON cm.account_id = cp.account_id
      AND cm.campaign_id = ${input.campaignId}::uuid
      AND cm.selected_contact_point_id = cp.id
    JOIN accounts a ON a.id = cp.account_id AND a.workspace_id = cp.workspace_id
    WHERE cp.id = ${input.contactPointId}::uuid
      AND cp.workspace_id = ${input.workspaceId}::uuid
      AND cp.type = 'email'
      AND cp.last_contacted_at IS NULL
      AND cm.contacted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM suppression_entries se
        WHERE se.workspace_id = cp.workspace_id
          AND (se.account_id = cp.account_id OR se.contact_point_id = cp.id)
      )
      AND NOT ${actualPriorColdOutreachSql({
        workspaceId: "cp.workspace_id",
        accountId: "cp.account_id",
        contactPointId: "cp.id",
        normalizedEmail: "cp.normalized_value",
      })}
      AND NOT EXISTS (
        SELECT 1 FROM conversations conv
        WHERE conv.workspace_id = cp.workspace_id
          AND conv.account_id = cp.account_id
          AND conv.state NOT IN ('rejected', 'no_reply_needed', 'suppressed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM meetings meeting
        JOIN conversations conv ON conv.id = meeting.conversation_id
        WHERE conv.workspace_id = cp.workspace_id
          AND conv.account_id = cp.account_id
      )
    LIMIT 1
  `);
  return result.rows.length === 1;
}

export async function POST(request: Request) {
  try {
    const auth = await requireWorkspaceAdmin();
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid admin E2E action." }, { status: 400 });
    }

    const campaignCheck = await validateCampaign(parsed.data.campaignId, auth.workspaceId);
    if ("response" in campaignCheck) return campaignCheck.response;

    if (parsed.data.action === "process") {
      const raw = await getRawCandidateById(parsed.data.rawCandidateId);
      if (!raw || raw.campaignId !== parsed.data.campaignId) {
        return NextResponse.json({ error: "Raw candidate does not belong to the requested campaign." }, { status: 404 });
      }

      const execution = await enqueueAdminScopedProcessingJob({
        executionId: parsed.data.executionId,
        campaignId: parsed.data.campaignId,
        rawCandidateId: raw.id,
      });
      if (!execution.created) {
        return NextResponse.json({ replayed: true, jobId: execution.jobId, jobStatus: execution.status });
      }
      const runner = await runProcessingCronTick(1, new Date(), {
        campaignId: parsed.data.campaignId,
        jobId: execution.jobId,
        jobTypes: ["process_raw_candidate"],
        rawCandidateIds: [raw.id],
        allowScopedDraftCampaign: true,
        enrichContacts: true,
        requireQualifiedForContactEnrichment: true,
        allowMapsFastWebsiteRecovery: false,
        allowNicheWebsiteClassificationEvidence: false,
      });
      return NextResponse.json({ replayed: false, jobId: execution.jobId, runner });
    }

    const contactPointExists = await hasExactSelectedContactPoint({
      campaignId: parsed.data.campaignId,
      workspaceId: auth.workspaceId,
      contactPointId: parsed.data.contactPointId,
    });
    if (!contactPointExists) {
      return NextResponse.json({ error: "Contact point is not the selected, unsent email for this campaign." }, { status: 409 });
    }

    if (parsed.data.action === "verify") {
      const result = await runVerificationCronTick(1, {
        campaignId: parsed.data.campaignId,
        contactPointIds: [parsed.data.contactPointId],
        allowScopedDraftCampaign: true,
        skipInstantlyImport: true,
      });
      return NextResponse.json({ verification: result, importAttempted: false });
    }

    const imported = await runAdminScopedDraftInstantlyImport({
      campaignId: parsed.data.campaignId,
      workspaceId: auth.workspaceId,
      contactPointId: parsed.data.contactPointId,
    });
    if (imported.status === "blocked") {
      return NextResponse.json({ error: "Scoped Draft import preflight failed.", reason: imported.reason, importAttempted: false }, { status: 409 });
    }
    return NextResponse.json({
      import: imported.result,
      importAttempted: imported.result.leadsAttempted > 0,
      leadsAdded: imported.result.leadsAdded,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }
    return NextResponse.json({ error: "Admin E2E action failed." }, { status: 500 });
  }
}