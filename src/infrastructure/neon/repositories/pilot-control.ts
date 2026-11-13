import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS } from "@/services/autopilot/multi-niche-rollout";
import { getDb } from "../db";

export type PilotControlStatus = "disabled" | "active" | "completed" | "aborted";

export interface PilotControlState {
  status: PilotControlStatus;
  sessionId: string | null;
  workspaceId: string | null;
  enabledAt: string | null;
  endedAt: string | null;
}

interface PilotControlRow {
  status: PilotControlStatus;
  session_id: string | null;
  workspace_id: string | null;
  enabled_at: Date | string | null;
  ended_at: Date | string | null;
}

function toState(row: PilotControlRow): PilotControlState {
  return {
    status: row.status,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    enabledAt: row.enabled_at instanceof Date ? row.enabled_at.toISOString() : row.enabled_at,
    endedAt: row.ended_at instanceof Date ? row.ended_at.toISOString() : row.ended_at,
  };
}

export async function getPilotControlState(): Promise<PilotControlState> {
  const result = await getDb().execute(sql`
    SELECT status, session_id, workspace_id, enabled_at, ended_at
    FROM pilot_control
    WHERE id = true
  `);
  const row = result.rows[0] as PilotControlRow | undefined;
  if (!row) throw new Error("Pilot control singleton is missing; pilot operations fail closed.");
  return toState(row);
}

export async function acquirePilotRunPermit(input: {
  runKey: string;
  runType: "recovery" | "scoped_smoke";
  sessionId: string;
  workspaceId: string;
  campaignId: string;
  discoveryJobId: string;
  actorUserId: string;
}): Promise<boolean> {
  const rolloutIds = sql.join(MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS.map((campaignId) => sql`${campaignId}::uuid`), sql`, `);
  const result = await getDb().execute(sql`
    WITH active_control AS MATERIALIZED (
      SELECT session_id, workspace_id
      FROM pilot_control
      WHERE id = true AND status = 'active'
      FOR SHARE
    ),
    inserted AS (
      INSERT INTO pilot_run_permits (
        run_key, session_id, run_type, campaign_id, discovery_job_id, charge_ceiling_usd
      )
      SELECT ${input.runKey}, control.session_id, ${input.runType}, ${input.campaignId}::uuid,
        ${input.discoveryJobId}::uuid, 0.50
      FROM active_control control
      JOIN autopilot_settings settings ON settings.workspace_id = control.workspace_id
      WHERE control.session_id = ${input.sessionId}::uuid
        AND control.workspace_id = ${input.workspaceId}::uuid
        AND settings.emergency_stopped = false
        AND (
          (${input.runType} = 'scoped_smoke'
            AND ${input.runKey} = ${input.campaignId}
            AND ${input.campaignId}::uuid IN (${rolloutIds})
            AND EXISTS (
              SELECT 1 FROM campaigns campaign
              WHERE campaign.id = ${input.campaignId}::uuid
                AND campaign.workspace_id = control.workspace_id
                AND campaign.status = 'draft'
                AND campaign.autopilot_enabled = false
            ))
          OR
          (${input.runType} = 'recovery'
            AND ${input.runKey} = 'recovery'
            AND EXISTS (
              SELECT 1 FROM campaigns campaign
              WHERE campaign.id = ${input.campaignId}::uuid
                AND campaign.workspace_id = control.workspace_id
                AND campaign.status = 'active'
                AND campaign.autopilot_enabled = true
                AND campaign.engine_type IN ('maps_fast', 'maps_deep')
            ))
        )
      ON CONFLICT (run_key) DO NOTHING
      RETURNING run_key, session_id, run_type, campaign_id, discovery_job_id
    ), audited AS (
      INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
      SELECT ${input.workspaceId}::uuid, ${input.actorUserId},
        CASE WHEN run_type = 'recovery' THEN 'isolated_pilot_recovery_permit_reserved' ELSE 'isolated_pilot_smoke_permit_reserved' END,
        'pilot_run_permit', run_key,
        jsonb_build_object('sessionId', session_id, 'campaignId', campaign_id, 'discoveryJobId', discovery_job_id, 'chargeCeilingUsd', 0.50)
      FROM inserted
      RETURNING id
    )
    SELECT inserted.run_key FROM inserted CROSS JOIN audited
  `);
  return result.rows.length === 1;
}

export async function isPilotRunPermitActive(input: {
  runKey: string;
  sessionId: string;
  workspaceId: string;
  campaignId: string;
  discoveryJobId: string;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1
    FROM pilot_run_permits permit
    JOIN pilot_control control ON control.id = true
      AND control.status = 'active'
      AND control.session_id = permit.session_id
      AND control.workspace_id = ${input.workspaceId}::uuid
    JOIN autopilot_settings settings ON settings.workspace_id = control.workspace_id
      AND settings.emergency_stopped = false
    WHERE permit.run_key = ${input.runKey}
      AND permit.session_id = ${input.sessionId}::uuid
      AND permit.campaign_id = ${input.campaignId}::uuid
      AND permit.discovery_job_id = ${input.discoveryJobId}::uuid
      AND permit.status IN ('reserved', 'running', 'completed')
  `);
  return result.rows.length === 1;
}

export async function startIsolatedPilot(input: { workspaceId: string; actorUserId: string }): Promise<PilotControlState> {
  const sessionId = randomUUID();
  const campaignIds = sql.join(MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS.map((campaignId) => sql`${campaignId}::uuid`), sql`, `);
  const result = await getDb().execute(sql`
    WITH singleton_lock AS MATERIALIZED (
      SELECT id
      FROM pilot_control
      WHERE id = true
      FOR UPDATE
    ),
    valid_campaigns AS MATERIALIZED (
      SELECT COUNT(DISTINCT id)::int AS count
      FROM campaigns
      WHERE workspace_id = ${input.workspaceId}::uuid
        AND id IN (${campaignIds})
        AND status = 'draft'
        AND autopilot_enabled = false
    ),
    updated AS (
      UPDATE pilot_control control
      SET status = 'active',
          session_id = ${sessionId}::uuid,
          workspace_id = ${input.workspaceId}::uuid,
          enabled_by = ${input.actorUserId},
          enabled_at = NOW(),
          ended_by = NULL,
          ended_at = NULL,
          updated_at = NOW()
      WHERE control.id = true
        AND control.status = 'disabled'
        AND EXISTS (SELECT 1 FROM singleton_lock)
        AND (SELECT count FROM valid_campaigns) = 4
        AND NOT EXISTS (
          SELECT 1 FROM autopilot_settings
          WHERE workspace_id = ${input.workspaceId}::uuid AND emergency_stopped = true
        )
        AND NOT EXISTS (SELECT 1 FROM discovery_jobs WHERE status = 'processing')
        AND NOT EXISTS (SELECT 1 FROM processing_jobs WHERE status = 'processing')
        AND NOT EXISTS (SELECT 1 FROM verification_jobs WHERE status = 'processing')
        AND NOT EXISTS (SELECT 1 FROM provider_runs WHERE status IN ('starting', 'queued', 'running', 'succeeded', 'ingesting'))
      RETURNING status, session_id, workspace_id, enabled_at, ended_at
    ),
    audited AS (
      INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
      SELECT workspace_id, ${input.actorUserId}, 'isolated_four_niche_pilot_enabled', 'pilot_control', session_id::text,
        jsonb_build_object('campaignIds', ${JSON.stringify(MULTI_NICHE_ROLLOUT_CAMPAIGN_IDS)}::jsonb, 'maxActorRuns', 5, 'maxChargePerRunUsd', 0.50)
      FROM updated
      RETURNING id
    )
    SELECT updated.status, updated.session_id, updated.workspace_id, updated.enabled_at, updated.ended_at
    FROM updated CROSS JOIN audited
  `);
  const row = result.rows[0] as PilotControlRow | undefined;
  if (!row) throw new Error("Pilot enable blocked: campaign scope, active work, or prior pilot state did not pass preflight.");
  return toState(row);
}

export async function restoreNormalOperation(input: { workspaceId: string; actorUserId: string }): Promise<PilotControlState> {
  const result = await getDb().execute(sql`
    WITH updated AS (
      UPDATE pilot_control
      SET status = CASE
        WHEN (SELECT COUNT(*) FROM pilot_run_permits WHERE session_id = pilot_control.session_id) = 5 THEN 'completed'
            ELSE 'aborted'
          END,
          ended_by = ${input.actorUserId},
          ended_at = NOW(),
          updated_at = NOW()
      WHERE id = true
        AND status = 'active'
        AND workspace_id = ${input.workspaceId}::uuid
      RETURNING status, session_id, workspace_id, enabled_at, ended_at
    ),
    audited AS (
      INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
      SELECT workspace_id, ${input.actorUserId}, 'isolated_four_niche_pilot_restored_normal_operation', 'pilot_control', session_id::text,
        jsonb_build_object('permitCount', (SELECT COUNT(*) FROM pilot_run_permits WHERE session_id = updated.session_id))
      FROM updated
      RETURNING id
    )
    SELECT updated.status, updated.session_id, updated.workspace_id, updated.enabled_at, updated.ended_at
    FROM updated CROSS JOIN audited
  `);
  const row = result.rows[0] as PilotControlRow | undefined;
  if (!row) throw new Error("Pilot restore blocked: there is no active pilot for this workspace.");
  return toState(row);
}