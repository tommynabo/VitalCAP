import { createRequire } from "node:module";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/infrastructure/neon/db";
import { toConversation, toFeedback, toMessage } from "@/infrastructure/neon/repositories/conversations";
import { resolveInboundContext } from "@/infrastructure/neon/repositories/setter-runtime";
import type { InboundEmailReply } from "@/domain/providers/types";
import { createSetterLLMProvider } from "@/infrastructure/providers/llm/factory";
import { getIntelligenceEnv } from "@/lib/config/env";
import { processIncomingReply } from "@/services/setter/setter-orchestrator";

const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

interface Candidate {
  draft: typeof schema.setterDrafts.$inferSelect;
  message: typeof schema.conversationMessages.$inferSelect;
  conversation: typeof schema.conversations.$inferSelect;
}

interface PreparedDraft {
  candidate: Candidate;
  output: NonNullable<Awaited<ReturnType<typeof processIncomingReply>>["draft"]>;
  providerMetadata: Record<string, unknown>;
  auditMetadata: Record<string, unknown>;
}

function requiredMetadataValue(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value) throw new Error(`Stored inbound message is missing ${key}.`);
  return value;
}

async function findCandidates(): Promise<Candidate[]> {
  const db = getDb();
  return db.select({ draft: schema.setterDrafts, message: schema.conversationMessages, conversation: schema.conversations })
    .from(schema.setterDrafts)
    .innerJoin(schema.conversationMessages, eq(schema.setterDrafts.conversationMessageId, schema.conversationMessages.id))
    .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
    .where(and(
      eq(schema.setterDrafts.branch, "HUMAN_REQUIRED"),
      eq(schema.setterDrafts.needsHuman, true),
      eq(schema.conversationMessages.direction, "incoming"),
      eq(schema.conversations.state, "pending_review"),
      sql`${schema.setterDrafts.providerMetadata}->>'provider' = 'disabled-llm'`,
    ));
}

async function prepareReprocess(candidate: Candidate, provider: ReturnType<typeof createSetterLLMProvider>): Promise<PreparedDraft> {
  const db = getDb();
  const metadata = candidate.message.metadata as Record<string, unknown>;
  const providerMessageId = requiredMetadataValue(metadata, "providerMessageId");
  const event: InboundEmailReply = {
    eventType: metadata.eventType === "reply_received" ? "reply_received" : "email_replied",
    providerEventId: requiredMetadataValue(metadata, "providerEventId"),
    providerMessageId,
    providerThreadId: (candidate.conversation.providerThreadId ?? "").replace(/^instantly:/, ""),
    providerCampaignId: requiredMetadataValue(metadata, "providerCampaignId"),
    email: requiredMetadataValue(metadata, "leadEmail"),
    subject: typeof metadata.subject === "string" ? metadata.subject : "",
    body: candidate.message.body,
    occurredAt: candidate.message.createdAt.toISOString(),
    campaignName: typeof metadata.campaignName === "string" ? metadata.campaignName : null,
    workspace: typeof metadata.workspace === "string" ? metadata.workspace : null,
    emailAccount: typeof metadata.emailAccount === "string" ? metadata.emailAccount : null,
  };
  if (!event.providerThreadId) throw new Error(`Conversation ${candidate.conversation.id} has no provider thread identity.`);

  const resolved = await resolveInboundContext(event);
  if (resolved.context.workspaceId !== candidate.conversation.workspaceId || resolved.accountId !== candidate.conversation.accountId) {
    throw new Error(`Stored context no longer matches conversation ${candidate.conversation.id}.`);
  }

  const [messageRows, feedbackRows] = await Promise.all([
    db.select().from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, candidate.conversation.id))
      .orderBy(desc(schema.conversationMessages.createdAt))
      .limit(10),
    db.select({ feedback: schema.setterFeedback })
      .from(schema.setterFeedback)
      .innerJoin(schema.conversationMessages, eq(schema.setterFeedback.conversationMessageId, schema.conversationMessages.id))
      .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
      .where(and(
        eq(schema.conversations.workspaceId, candidate.conversation.workspaceId),
        eq(schema.conversations.accountId, candidate.conversation.accountId),
      ))
      .orderBy(desc(schema.setterFeedback.reviewedAt))
      .limit(5),
  ]);

  const result = await processIncomingReply({
    workspaceId: resolved.context.workspaceId,
    conversation: toConversation(candidate.conversation),
    incomingMessage: toMessage(candidate.message),
    conversationMessages: messageRows.reverse().map(toMessage),
    offer: resolved.context.offer,
    account: resolved.context.account,
    contact: resolved.context.contact,
    discoverySource: resolved.context.discoverySource,
    recentFeedback: feedbackRows.map(({ feedback }) => toFeedback(feedback)),
    suppressionEntries: resolved.context.suppressionEntries,
    contactPointId: resolved.context.contactPointId,
    llmProvider: provider,
    now: new Date(),
  });

  if (!result.draft) throw new Error(`Setter produced no draft for existing message ${candidate.message.id}.`);
  if (result.draft.providerMetadata?.provider !== "anthropic-setter" || !result.draft.providerMetadata.model || result.draft.providerMetadata.failureCode) {
    throw new Error(`Expected Anthropic output for existing message ${candidate.message.id}.`);
  }

  const reprocessedAt = new Date().toISOString();
  const providerMetadata = {
    ...result.draft.providerMetadata,
    previousProviderMetadata: candidate.draft.providerMetadata,
    reprocessedAt,
    reprocessReason: "anthropic_provider_enabled",
  };
  const auditMetadata = {
    priorProvider: "disabled-llm",
    provider: "anthropic-setter",
    model: result.draft.providerMetadata.model ?? null,
    conversationMessageId: candidate.message.id,
    previousBranch: candidate.draft.branch,
    branch: result.draft.branch,
    needsHuman: true,
  };

  return { candidate, output: result.draft, providerMetadata, auditMetadata };
}

async function persistReprocessedDrafts(prepared: PreparedDraft[]): Promise<void> {
  const updates = prepared.map(({ candidate, output, providerMetadata, auditMetadata }) => ({
    draftId: candidate.draft.id,
    messageId: candidate.message.id,
    language: output.language,
    branch: output.branch,
    intentSummary: output.intentSummary,
    confidence: output.confidence,
    draftText: output.draft,
    reasonForHuman: output.reasonForHuman,
    detectedFactsRequested: output.detectedFactsRequested,
    riskFlags: output.riskFlags,
    suggestedNextAction: output.suggestedNextAction,
    providerMetadata,
    auditMetadata,
  }));

  const db = getDb();
  const updated = await db.execute(sql`
    WITH requested AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS item (
        draft_id uuid, message_id uuid, language text, branch text, intent_summary text,
        confidence numeric, draft_text text, reason_for_human text,
        detected_facts_requested jsonb, risk_flags jsonb, suggested_next_action text,
        provider_metadata jsonb, audit_metadata jsonb
      )
    ), eligible AS (
      SELECT count(*) AS total
      FROM setter_drafts AS draft
      JOIN conversation_messages AS message ON message.id = draft.conversation_message_id
      JOIN conversations AS conversation ON conversation.id = message.conversation_id
      WHERE draft.id IN (SELECT draft_id FROM requested)
        AND draft.branch = 'HUMAN_REQUIRED'
        AND draft.needs_human = true
        AND draft.provider_metadata->>'provider' = 'disabled-llm'
        AND conversation.state = 'pending_review'
    ), updated AS (
      UPDATE setter_drafts AS draft
      SET language = requested.language,
          branch = requested.branch,
          intent_summary = requested.intent_summary,
          confidence = requested.confidence,
          draft = requested.draft_text,
          needs_human = true,
          reason_for_human = requested.reason_for_human,
          detected_facts_requested = requested.detected_facts_requested,
          risk_flags = requested.risk_flags,
          suggested_next_action = requested.suggested_next_action,
          provider_metadata = requested.provider_metadata
      FROM requested
      CROSS JOIN eligible
      JOIN conversation_messages AS message ON message.id = requested.message_id
      JOIN conversations AS conversation ON conversation.id = message.conversation_id
      WHERE eligible.total = 2
        AND draft.id = requested.draft_id
        AND draft.conversation_message_id = requested.message_id
        AND draft.branch = 'HUMAN_REQUIRED'
        AND draft.needs_human = true
        AND draft.provider_metadata->>'provider' = 'disabled-llm'
        AND message.id = draft.conversation_message_id
        AND conversation.state = 'pending_review'
      RETURNING draft.id, draft.conversation_message_id, draft.branch
    ), updated_conversations AS (
      UPDATE conversations AS conversation
      SET latest_intent = updated.branch, updated_at = NOW()
      FROM updated
      JOIN conversation_messages AS message ON message.id = updated.conversation_message_id
      WHERE conversation.id = message.conversation_id AND conversation.state = 'pending_review'
      RETURNING conversation.id
    ), audited AS (
      INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
      SELECT conversation.workspace_id, NULL, 'setter.draft.reprocessed', 'setter_draft', updated.id::text,
             requested.audit_metadata
      FROM updated
      JOIN requested ON requested.draft_id = updated.id
      JOIN conversation_messages AS message ON message.id = updated.conversation_message_id
      JOIN conversations AS conversation ON conversation.id = message.conversation_id
      JOIN updated_conversations ON updated_conversations.id = conversation.id
      RETURNING entity_id
    )
    SELECT entity_id FROM audited;
  `);

  if (updated.rows.length !== prepared.length) {
    throw new Error("Draft rows were not updated; safety preconditions no longer hold.");
  }
  for (const { candidate } of prepared) {
    console.log(`Updated existing draft ${candidate.draft.id}; human review remains required.`);
  }
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false);
  const apply = process.argv.includes("--apply");
  if (process.argv.some((argument) => argument !== "--apply" && argument !== process.argv[0] && argument !== process.argv[1])) {
    throw new Error("Usage: npm run reprocess:setter-fallbacks [-- --apply]");
  }
  if (process.env.AUTO_SEND?.toLowerCase() === "true" || process.env.DEFAULT_DELIVERY_MODE === "live") {
    throw new Error("Refusing to run while outbound delivery is enabled.");
  }

  const candidates = await findCandidates();
  if (candidates.length !== 2) {
    throw new Error(`Expected exactly 2 disabled-LLM fallback drafts in pending review; found ${candidates.length}. No rows were changed.`);
  }
  console.log(`Found exactly ${candidates.length} eligible drafts: ${candidates.map(({ draft }) => draft.id).join(", ")}.`);
  if (!apply) {
    console.log("Preview only. Pass --apply to reprocess these same existing draft rows.");
    return;
  }

  const intel = getIntelligenceEnv();
  const provider = createSetterLLMProvider({
    ...intel,
    LLM_PROVIDER: "anthropic",
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    CLAUDE_WORKSPACE_ID: process.env.CLAUDE_WORKSPACE_ID,
  }, "production");
  const prepared: PreparedDraft[] = [];
  for (const candidate of candidates) prepared.push(await prepareReprocess(candidate, provider));
  await persistReprocessedDrafts(prepared);
  console.log("Reprocessing complete. No webhook replay, message insert, conversation insert, or email send occurred.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Setter draft reprocessing failed.");
  process.exitCode = 1;
});