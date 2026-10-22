import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/infrastructure/neon/db";

export interface ConfiguredInstantlyCampaign {
  providerCampaignId: string;
  workspaceId: string;
}

export interface InstantlyInboxCampaignDiscoveryCounts {
  configuredCampaignCount: number;
  mappingTableCampaignCount: number;
  engineConfigCampaignCount: number;
  importProviderCampaignCount: number;
  importRowsForTargetCampaign: number;
  envTargetCampaignConfigured: boolean;
}

export interface InstantlyInboxCheckpoint {
  checkpointAt: string | null;
  windowStartedAt: string | null;
  nextStartingAfter: string | null;
}

export interface SetterReplyReadbackCandidate {
  workspaceId: string;
  campaignId: string;
  conversationId: string;
  providerCampaignId: string;
  providerMessageId: string | null;
  email: string;
  emailAccount: string | null;
  providerThreadId: string | null;
  replyToUuid: string | null;
  subject: string;
  finalText: string;
  attemptedAt: string;
  setterDraftId: string;
}

const ACTIVE_IMPORT_STATUSES = ["instantly_added", "skipped_existing"] as const;

export function dedupeConfiguredInstantlyCampaigns(
  ...sources: ConfiguredInstantlyCampaign[][]
): ConfiguredInstantlyCampaign[] {
  const targets = new Map<string, ConfiguredInstantlyCampaign>();
  for (const source of sources) {
    for (const target of source) {
      const key = `${target.workspaceId}:${target.providerCampaignId}`;
      if (!targets.has(key)) targets.set(key, target);
    }
  }
  return [...targets.values()];
}

export async function listConfiguredInstantlyCampaigns(workspaceId?: string): Promise<ConfiguredInstantlyCampaign[]> {
  const db = getDb();
  const mappedConditions = [
    eq(schema.campaignProviderMappings.provider, "instantly"),
    eq(schema.campaignProviderMappings.enabled, true),
  ];
  if (workspaceId) mappedConditions.push(eq(schema.campaignProviderMappings.workspaceId, workspaceId));
  const mappings = await db.select({
    providerCampaignId: schema.campaignProviderMappings.providerCampaignId,
    workspaceId: schema.campaignProviderMappings.workspaceId,
  })
    .from(schema.campaignProviderMappings)
    .where(and(...mappedConditions));

  const campaignConditions = [or(
    sql`${schema.campaigns.engineConfig}->>'instantlyCampaignId' IS NOT NULL`,
    sql`${schema.campaigns.engineConfig}->>'providerCampaignId' IS NOT NULL`,
  )!];
  if (workspaceId) campaignConditions.push(eq(schema.campaigns.workspaceId, workspaceId));
  const configuredCampaigns = await db.select({
    workspaceId: schema.campaigns.workspaceId,
    engineConfig: schema.campaigns.engineConfig,
  })
    .from(schema.campaigns)
    .where(and(...campaignConditions));

  const engineConfigTargets: ConfiguredInstantlyCampaign[] = [];
  for (const campaign of configuredCampaigns) {
    const config = campaign.engineConfig !== null && typeof campaign.engineConfig === "object" && !Array.isArray(campaign.engineConfig)
      ? campaign.engineConfig as Record<string, unknown>
      : {};
    const providerCampaignId = [config.instantlyCampaignId, config.providerCampaignId]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    if (providerCampaignId) engineConfigTargets.push({ providerCampaignId, workspaceId: campaign.workspaceId });
  }

  const importConditions = [inArray(schema.instantlyLeadImports.status, [...ACTIVE_IMPORT_STATUSES])];
  if (workspaceId) importConditions.push(eq(schema.instantlyLeadImports.workspaceId, workspaceId));
  const importedTargets = await db.selectDistinct({
    providerCampaignId: schema.instantlyLeadImports.providerCampaignId,
    workspaceId: schema.instantlyLeadImports.workspaceId,
  })
    .from(schema.instantlyLeadImports)
    .where(and(...importConditions));

  return dedupeConfiguredInstantlyCampaigns(
    mappings,
    engineConfigTargets,
    importedTargets,
  );
}

export async function getInstantlyInboxCampaignDiscoveryCounts(
  workspaceId: string,
  envTargetCampaignId: string,
): Promise<InstantlyInboxCampaignDiscoveryCounts> {
  const db = getDb();
  const mappingRows = await db.selectDistinct({ providerCampaignId: schema.campaignProviderMappings.providerCampaignId })
    .from(schema.campaignProviderMappings)
    .where(and(
      eq(schema.campaignProviderMappings.provider, "instantly"),
      eq(schema.campaignProviderMappings.enabled, true),
      eq(schema.campaignProviderMappings.workspaceId, workspaceId),
    ));
  const campaignRows = await db.select({ engineConfig: schema.campaigns.engineConfig })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.workspaceId, workspaceId));
  const engineConfigCampaignIds = new Set<string>();
  for (const row of campaignRows) {
    const config = row.engineConfig !== null && typeof row.engineConfig === "object" && !Array.isArray(row.engineConfig)
      ? row.engineConfig as Record<string, unknown>
      : {};
    const providerCampaignId = [config.instantlyCampaignId, config.providerCampaignId]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
    if (providerCampaignId) engineConfigCampaignIds.add(providerCampaignId);
  }
  const importedTargets = await db.selectDistinct({ providerCampaignId: schema.instantlyLeadImports.providerCampaignId })
    .from(schema.instantlyLeadImports)
    .where(and(
      eq(schema.instantlyLeadImports.workspaceId, workspaceId),
      inArray(schema.instantlyLeadImports.status, [...ACTIVE_IMPORT_STATUSES]),
    ));
  const [targetImportCount] = await db.select({ count: sql<number>`count(*)::int` })
    .from(schema.instantlyLeadImports)
    .where(and(
      eq(schema.instantlyLeadImports.workspaceId, workspaceId),
      eq(schema.instantlyLeadImports.providerCampaignId, envTargetCampaignId),
      inArray(schema.instantlyLeadImports.status, [...ACTIVE_IMPORT_STATUSES]),
    ));
  const configured = await listConfiguredInstantlyCampaigns(workspaceId);
  return {
    configuredCampaignCount: configured.length,
    mappingTableCampaignCount: mappingRows.length,
    engineConfigCampaignCount: engineConfigCampaignIds.size,
    importProviderCampaignCount: importedTargets.length,
    importRowsForTargetCampaign: Number(targetImportCount?.count ?? 0),
    envTargetCampaignConfigured: Boolean(envTargetCampaignId && configured.some((target) => target.providerCampaignId === envTargetCampaignId)),
  };
}

export async function getInstantlyInboxCheckpoint(providerCampaignId: string): Promise<InstantlyInboxCheckpoint | null> {
  const db = getDb();
  const [row] = await db.select()
    .from(schema.instantlyInboxReconcileState)
    .where(eq(schema.instantlyInboxReconcileState.providerCampaignId, providerCampaignId))
    .limit(1);
  if (!row) return null;
  return {
    checkpointAt: row.checkpointAt?.toISOString() ?? null,
    windowStartedAt: row.windowStartedAt?.toISOString() ?? null,
    nextStartingAfter: row.nextStartingAfter,
  };
}

export async function saveInstantlyInboxCheckpoint(
  providerCampaignId: string,
  checkpoint: InstantlyInboxCheckpoint,
): Promise<void> {
  const db = getDb();
  await db.insert(schema.instantlyInboxReconcileState).values({
    providerCampaignId,
    checkpointAt: checkpoint.checkpointAt ? new Date(checkpoint.checkpointAt) : null,
    windowStartedAt: checkpoint.windowStartedAt ? new Date(checkpoint.windowStartedAt) : null,
    nextStartingAfter: checkpoint.nextStartingAfter,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: schema.instantlyInboxReconcileState.providerCampaignId,
    set: {
      checkpointAt: checkpoint.checkpointAt ? new Date(checkpoint.checkpointAt) : null,
      windowStartedAt: checkpoint.windowStartedAt ? new Date(checkpoint.windowStartedAt) : null,
      nextStartingAfter: checkpoint.nextStartingAfter,
      updatedAt: new Date(),
    },
  });
}

export async function listSetterReplyReadbackCandidates(input: {
  workspaceId?: string;
  limit?: number;
  staleSendingBefore: Date;
}): Promise<SetterReplyReadbackCandidate[]> {
  const db = getDb();
  const conditions = [or(
    inArray(schema.conversations.state, ["send_accepted", "send_unknown"]),
    and(eq(schema.conversations.state, "sending"), lt(schema.conversations.updatedAt, input.staleSendingBefore)),
  )!];
  if (input.workspaceId) conditions.push(eq(schema.conversations.workspaceId, input.workspaceId));

  const rows = await db.select({
    workspaceId: schema.conversations.workspaceId,
    campaignId: schema.conversations.campaignId,
    conversationId: schema.conversations.id,
    providerCampaignId: sql<string | null>`${schema.conversationMessages.metadata}->>'providerCampaignId'`,
    providerMessageId: sql<string | null>`${schema.conversationMessages.metadata}->'replyDelivery'->>'providerMessageId'`,
    email: sql<string | null>`${schema.conversationMessages.metadata}->>'leadEmail'`,
    emailAccount: sql<string | null>`coalesce(${schema.conversationMessages.metadata}->>'emailAccount', ${schema.conversationMessages.metadata}->>'eaccount')`,
    providerThreadId: sql<string | null>`${schema.conversationMessages.metadata}->>'providerThreadId'`,
    replyToUuid: sql<string | null>`${schema.conversationMessages.metadata}->>'replyToUuid'`,
    subject: sql<string | null>`${schema.conversationMessages.metadata}->>'subject'`,
    finalText: schema.setterFeedback.finalText,
    attemptedAt: sql<Date>`coalesce(
      nullif(${schema.conversationMessages.metadata}->'replyDelivery'->>'attemptedAt', '')::timestamptz,
      nullif(${schema.conversationMessages.metadata}->'replyDelivery'->>'failedAt', '')::timestamptz,
      ${schema.conversations.updatedAt}
    )`,
    setterDraftId: sql<string | null>`${schema.conversationMessages.metadata}->'replyDelivery'->>'setterDraftId'`,
  })
    .from(schema.conversationMessages)
    .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
    .innerJoin(schema.setterFeedback, eq(schema.setterFeedback.conversationMessageId, schema.conversationMessages.id))
    .where(and(eq(schema.conversationMessages.direction, "incoming"), ...conditions))
    .limit(Math.min(100, Math.max(1, input.limit ?? 100)));

  return rows.flatMap((row) => {
    if (!row.providerCampaignId || !row.email || !row.finalText || !row.setterDraftId) return [];
    return [{
      ...row,
      providerCampaignId: row.providerCampaignId,
      email: row.email,
      emailAccount: row.emailAccount,
      providerThreadId: row.providerThreadId,
      replyToUuid: row.replyToUuid,
      subject: row.subject ?? "",
      finalText: row.finalText,
      attemptedAt: row.attemptedAt.toISOString(),
      setterDraftId: row.setterDraftId,
    }];
  });
}
