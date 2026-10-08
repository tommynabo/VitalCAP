import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/infrastructure/neon/db";
import { toConversation, toFeedback, toMessage } from "@/infrastructure/neon/repositories/conversations";
import { resolveInboundContext } from "@/infrastructure/neon/repositories/setter-runtime";
import type { InboundEmailReply } from "@/domain/providers/types";
import { createSetterLLMProvider } from "@/infrastructure/providers/llm/factory";
import { getIntelligenceEnv } from "@/lib/config/env";
import { processIncomingReply } from "@/services/setter/setter-orchestrator";
import { validateSetterOutput } from "@/services/setter/setter-output-schema";

const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

export interface Candidate {
  draft: typeof schema.setterDrafts.$inferSelect;
  message: typeof schema.conversationMessages.$inferSelect;
  conversation: typeof schema.conversations.$inferSelect;
}

export interface PreparedDraft {
  candidate: Candidate;
  output: NonNullable<Awaited<ReturnType<typeof processIncomingReply>>["draft"]>;
  providerMetadata: Record<string, unknown>;
  auditMetadata: Record<string, unknown>;
}

export interface ReprocessArguments {
  apply: boolean;
  diagnose: boolean;
  draftIds: string[];
  conversationIds: string[];
}

interface TargetDiagnostic {
  stageReached: string;
  activeStage: string;
  errorStage: string | null;
  errorClass: string | null;
  errorStatus: number | null;
  errorCode: string | null;
  safeErrorMessage: string | null;
  providerCall: "PASS" | "FAIL" | "NOT_REACHED";
  schemaValid: boolean | null;
  branch: string | null;
  confidencePresent: boolean | null;
  draftNonempty: boolean | null;
}

export interface TargetSelection {
  requested: number;
  validated: number;
  eligible: Candidate[];
  skippedSuccessful: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function setReprocessEnvironmentMode(environment: NodeJS.ProcessEnv = process.env): void {
  Reflect.set(environment, "NODE_ENV", "production");
}

export function loadReprocessEnvironment(): void {
  setReprocessEnvironmentMode();
  loadEnvConfig(process.cwd(), false);
}

export function parseReprocessArguments(args: string[]): ReprocessArguments {
  const result: ReprocessArguments = { apply: false, diagnose: false, draftIds: [], conversationIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      result.apply = true;
      continue;
    }
    if (argument === "--diagnose") {
      result.diagnose = true;
      continue;
    }
    if (argument !== "--draft-id" && argument !== "--conversation-id") {
      throw new Error("Usage: npx tsx scripts/reprocess-setter-fallback-drafts.ts (--draft-id <uuid> | --conversation-id <uuid>)... [--apply | --diagnose]");
    }
    const value = args[index + 1];
    if (!value || !UUID_PATTERN.test(value)) throw new Error(`${argument} requires a full UUID.`);
    const targetIds = argument === "--draft-id" ? result.draftIds : result.conversationIds;
    if (targetIds.includes(value)) throw new Error("Duplicate target identifier.");
    targetIds.push(value);
    index += 1;
  }
  if (result.draftIds.length + result.conversationIds.length === 0) {
    throw new Error("At least one explicit --draft-id or --conversation-id target is required.");
  }
  if (result.apply && result.diagnose) throw new Error("--apply and --diagnose cannot be combined.");
  return result;
}

function isSuccessfulReprocess(candidate: Candidate): boolean {
  const metadata = candidate.draft.providerMetadata as Record<string, unknown>;
  return metadata.provider === "anthropic-setter"
    && metadata.reprocessReason === "anthropic_provider_enabled"
    && metadata.model === "claude-sonnet-5-5"
    && !metadata.failureCode
    && candidate.draft.needsHuman;
}

export function selectAndValidateTargets(candidates: Candidate[], args: ReprocessArguments): TargetSelection {
  const selected = new Map<string, Candidate>();
  for (const id of args.draftIds) {
    const matches = candidates.filter(({ draft }) => draft.id === id);
    const [candidate] = matches;
    if (matches.length !== 1 || !candidate) throw new Error("A requested draft target did not resolve uniquely.");
    selected.set(candidate.draft.id, candidate);
  }
  for (const id of args.conversationIds) {
    const matches = candidates.filter(({ conversation }) => conversation.id === id);
    const [candidate] = matches;
    if (matches.length !== 1 || !candidate) throw new Error("A requested conversation target did not resolve to one draft.");
    if (selected.has(candidate.draft.id)) throw new Error("Target identifiers overlap.");
    selected.set(candidate.draft.id, candidate);
  }

  const rows = [...selected.values()];
  const eligible: Candidate[] = [];
  let skippedSuccessful = 0;
  for (const candidate of rows) {
    if (isSuccessfulReprocess(candidate)) {
      skippedSuccessful += 1;
      continue;
    }
    const metadata = candidate.message.metadata as Record<string, unknown>;
    const providerMessageId = metadata.providerMessageId;
    const valid = candidate.draft.branch === "HUMAN_REQUIRED"
      && candidate.draft.needsHuman
      && (candidate.draft.providerMetadata as Record<string, unknown>).provider === "disabled-llm"
      && candidate.conversation.state === "pending_review"
      && candidate.message.direction === "incoming"
      && (metadata.eventType === "reply_received" || metadata.eventType === "email_replied")
      && typeof providerMessageId === "string" && providerMessageId.length > 0
      && typeof metadata.providerEventId === "string" && metadata.providerEventId.length > 0
      && candidate.message.providerMessageId === `instantly:${providerMessageId}`;
    if (!valid) throw new Error("A requested target failed fallback, inbound-reply, or human-review validation.");
    eligible.push(candidate);
  }
  return {
    requested: args.draftIds.length + args.conversationIds.length,
    validated: rows.length,
    eligible,
    skippedSuccessful,
  };
}

function requiredMetadataValue(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value) throw new Error(`Stored inbound message is missing ${key}.`);
  return value;
}

async function findCandidates(args: ReprocessArguments): Promise<Candidate[]> {
  const db = getDb();
  const targetConditions = [];
  if (args.draftIds.length) targetConditions.push(inArray(schema.setterDrafts.id, args.draftIds));
  if (args.conversationIds.length) targetConditions.push(inArray(schema.conversations.id, args.conversationIds));
  return db.select({ draft: schema.setterDrafts, message: schema.conversationMessages, conversation: schema.conversations })
    .from(schema.setterDrafts)
    .innerJoin(schema.conversationMessages, eq(schema.setterDrafts.conversationMessageId, schema.conversationMessages.id))
    .innerJoin(schema.conversations, eq(schema.conversationMessages.conversationId, schema.conversations.id))
    .where(or(...targetConditions));
}

async function prepareReprocess(
  candidate: Candidate,
  provider: ReturnType<typeof createSetterLLMProvider>,
  diagnostic?: TargetDiagnostic,
): Promise<PreparedDraft> {
  const db = getDb();
  const metadata = candidate.message.metadata as Record<string, unknown>;
  if (diagnostic) diagnostic.activeStage = "BUILD_INBOUND_EVENT";
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
  if (diagnostic) diagnostic.stageReached = "INBOUND_EVENT_BUILT";

  if (diagnostic) diagnostic.activeStage = "HYDRATE_CAMPAIGN_ACCOUNT_CONTEXT";
  const resolved = await resolveInboundContext(event);
  if (diagnostic) diagnostic.stageReached = "INBOUND_CONTEXT_HYDRATED";
  if (diagnostic) diagnostic.activeStage = "VERIFY_RESOLVED_CONTEXT";
  if (resolved.context.workspaceId !== candidate.conversation.workspaceId || resolved.accountId !== candidate.conversation.accountId) {
    throw new Error(`Stored context no longer matches conversation ${candidate.conversation.id}.`);
  }
  if (diagnostic) diagnostic.stageReached = "RESOLVED_CONTEXT_VERIFIED";

  if (diagnostic) diagnostic.activeStage = "LOAD_RECENT_MESSAGES_AND_FEEDBACK";
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
  if (diagnostic) diagnostic.stageReached = "RECENT_CONTEXT_HYDRATED";

  if (diagnostic) diagnostic.activeStage = "RUN_SETTER_ORCHESTRATOR";
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
  if (diagnostic) diagnostic.stageReached = "SETTER_ORCHESTRATION_COMPLETED";

  if (diagnostic) diagnostic.activeStage = "VALIDATE_SETTER_RESULT";
  const resultMetadata = result.draft?.providerMetadata;
  if (diagnostic && resultMetadata?.failureCode === "invalid_llm_output" && diagnostic.errorStage === null) {
    setDiagnosticError(diagnostic, "SCHEMA_VALIDATION", "SetterSchemaValidationError", null, "INVALID_SETTER_OUTPUT", "Provider output did not match the Setter schema.");
  }
  if (diagnostic && !result.draft && diagnostic.errorStage === null) {
    setDiagnosticError(diagnostic, "SETTER_ORCHESTRATION", "SetterDraftNotProducedError", null, "NO_DRAFT", "Setter orchestration did not produce a review draft.");
  }
  if (!result.draft) throw new Error(`Setter produced no draft for existing message ${candidate.message.id}.`);
  if (result.draft.providerMetadata?.provider !== "anthropic-setter" || !result.draft.providerMetadata.model || result.draft.providerMetadata.failureCode) {
    if (diagnostic && diagnostic.errorStage === null) {
      setDiagnosticError(diagnostic, "VALIDATE_SETTER_RESULT", "SetterProviderOutputError", null, "EXPECTED_ANTHROPIC_OUTPUT", "Expected a successful Anthropic Setter result.");
    }
    throw new Error(`Expected Anthropic output for existing message ${candidate.message.id}.`);
  }
  if (diagnostic) diagnostic.stageReached = "SETTER_RESULT_VALIDATED";

  if (diagnostic) diagnostic.activeStage = "PREPARE_REPLACEMENT_AND_AUDIT_METADATA";
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

  if (diagnostic) {
    diagnostic.stageReached = "REPLACEMENT_DRAFT_PREPARED";
    diagnostic.branch = result.draft.branch;
    diagnostic.confidencePresent = typeof result.draft.confidence === "number";
    diagnostic.draftNonempty = result.draft.draft.trim().length > 0;
  }
  return { candidate, output: result.draft, providerMetadata, auditMetadata };
}

function setDiagnosticError(
  diagnostic: TargetDiagnostic,
  stage: string,
  errorClass: string,
  status: number | null,
  code: string | null,
  safeMessage: string,
): void {
  diagnostic.errorStage = stage;
  diagnostic.errorClass = errorClass;
  diagnostic.errorStatus = status;
  diagnostic.errorCode = code;
  diagnostic.safeErrorMessage = safeMessage;
}

function diagnosticProvider(
  provider: ReturnType<typeof createSetterLLMProvider>,
  diagnostic: TargetDiagnostic,
): ReturnType<typeof createSetterLLMProvider> {
  return {
    providerName: provider.providerName,
    async classifyAndDraft(context) {
      diagnostic.activeStage = "ANTHROPIC_PROVIDER_CALL";
      try {
        const response = await provider.classifyAndDraft(context);
        diagnostic.providerCall = "PASS";
        diagnostic.activeStage = "VALIDATE_STRUCTURED_OUTPUT";
        const validation = validateSetterOutput(response.output);
        diagnostic.schemaValid = validation.success;
        diagnostic.branch = validation.success ? validation.data?.branch ?? null : null;
        diagnostic.confidencePresent = typeof response.output.confidence === "number";
        diagnostic.draftNonempty = typeof response.output.draft === "string" && response.output.draft.trim().length > 0;
        diagnostic.stageReached = validation.success ? "STRUCTURED_OUTPUT_VALIDATED" : "STRUCTURED_OUTPUT_REJECTED";
        diagnostic.activeStage = "RUN_SETTER_ORCHESTRATOR";
        return response;
      } catch (error) {
        diagnostic.providerCall = "FAIL";
        const details = error as { name?: unknown; status?: unknown; code?: unknown } | null;
        const errorClass = typeof details?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(details.name)
          ? details.name
          : "ProviderError";
        const status = typeof details?.status === "number" && Number.isInteger(details.status) ? details.status : null;
        const code = typeof details?.code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(details.code) ? details.code : null;
        const safeMessage = status === 429
          ? "Provider rate limit prevented the request."
          : status === 401 || status === 403
            ? "Provider authentication was rejected."
            : status !== null && status >= 500
              ? "Provider returned a server error."
              : errorClass === "APIConnectionTimeoutError" || code === "ETIMEDOUT"
                ? "Provider request timed out."
                : "Provider request failed; details redacted.";
        setDiagnosticError(diagnostic, "ANTHROPIC_PROVIDER_CALL", errorClass, status, code, safeMessage);
        throw error;
      }
    },
  };
}

function createTargetDiagnostic(): TargetDiagnostic {
  return {
    stageReached: "TARGET_VALIDATED",
    activeStage: "CREATE_ANTHROPIC_PROVIDER",
    errorStage: null,
    errorClass: null,
    errorStatus: null,
    errorCode: null,
    safeErrorMessage: null,
    providerCall: "NOT_REACHED",
    schemaValid: null,
    branch: null,
    confidencePresent: null,
    draftNonempty: null,
  };
}

function reportTargetDiagnostic(index: number, diagnostic: TargetDiagnostic): void {
  console.log(`ITEM_${index}_STAGE_REACHED=${diagnostic.stageReached}`);
  console.log(`ITEM_${index}_ERROR_STAGE=${diagnostic.errorStage ?? "NONE"}`);
  console.log(`ITEM_${index}_ERROR_CLASS=${diagnostic.errorClass ?? "NONE"}`);
  console.log(`ITEM_${index}_ERROR_STATUS=${diagnostic.errorStatus ?? "NONE"}`);
  console.log(`ITEM_${index}_ERROR_CODE=${diagnostic.errorCode ?? "NONE"}`);
  console.log(`ITEM_${index}_SAFE_ERROR_MESSAGE=${diagnostic.safeErrorMessage ?? "NONE"}`);
  console.log(`ITEM_${index}_PROVIDER_CALL=${diagnostic.providerCall}`);
  console.log(`ITEM_${index}_SCHEMA_VALID=${diagnostic.schemaValid === null ? "NOT_REACHED" : diagnostic.schemaValid ? "YES" : "NO"}`);
  console.log(`ITEM_${index}_BRANCH=${diagnostic.branch ?? "NOT_AVAILABLE"}`);
  console.log(`ITEM_${index}_CONFIDENCE_PRESENT=${diagnostic.confidencePresent === null ? "NOT_REACHED" : diagnostic.confidencePresent ? "YES" : "NO"}`);
  console.log(`ITEM_${index}_DRAFT_NONEMPTY=${diagnostic.draftNonempty === null ? "NOT_REACHED" : diagnostic.draftNonempty ? "YES" : "NO"}`);
}

function recordDiagnosticException(diagnostic: TargetDiagnostic, error: unknown): void {
  if (diagnostic.errorStage !== null) return;
  const details = error as { name?: unknown; status?: unknown; code?: unknown } | null;
  const errorClass = typeof details?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(details.name)
    ? details.name
    : "Error";
  const status = typeof details?.status === "number" && Number.isInteger(details.status) ? details.status : null;
  const code = typeof details?.code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(details.code) ? details.code : null;
  const safeMessages: Record<string, string> = {
    BUILD_INBOUND_EVENT: "Stored inbound reply could not be constructed.",
    HYDRATE_CAMPAIGN_ACCOUNT_CONTEXT: "Offer or campaign context could not be hydrated.",
    VERIFY_RESOLVED_CONTEXT: "Resolved context did not match the stored conversation.",
    LOAD_RECENT_MESSAGES_AND_FEEDBACK: "Recent Setter context could not be loaded.",
    RUN_SETTER_ORCHESTRATOR: "Setter orchestration failed; details redacted.",
    VALIDATE_SETTER_RESULT: "Setter did not produce a successful Anthropic result.",
    PREPARE_REPLACEMENT_AND_AUDIT_METADATA: "Replacement draft metadata could not be prepared.",
    CREATE_ANTHROPIC_PROVIDER: "Anthropic provider configuration could not be loaded.",
  };
  setDiagnosticError(
    diagnostic,
    diagnostic.activeStage,
    errorClass,
    status,
    code,
    safeMessages[diagnostic.activeStage] ?? "Diagnostic stage failed; details redacted.",
  );
}

export function buildPersistenceStatement(prepared: PreparedDraft[]) {
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

  return sql`
    WITH requested AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS item (
        draft_id uuid, message_id uuid, language text, branch text, intent_summary text,
        confidence numeric, draft_text text, reason_for_human text,
        detected_facts_requested jsonb, risk_flags jsonb, suggested_next_action text,
        provider_metadata jsonb, audit_metadata jsonb
      )
    ), eligible AS (
      SELECT count(DISTINCT draft.id) AS total
      FROM setter_drafts AS draft
      JOIN conversation_messages AS message ON message.id = draft.conversation_message_id
      JOIN conversations AS conversation ON conversation.id = message.conversation_id
      WHERE draft.id IN (SELECT draft_id FROM requested)
        AND draft.branch = 'HUMAN_REQUIRED'
        AND draft.needs_human = true
        AND draft.provider_metadata->>'provider' = 'disabled-llm'
        AND conversation.state = 'pending_review'
        AND message.direction = 'incoming'
        AND coalesce(message.metadata->>'providerMessageId', '') <> ''
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
      WHERE eligible.total = ${updates.length}
        AND draft.id = requested.draft_id
        AND draft.conversation_message_id = requested.message_id
        AND draft.branch = 'HUMAN_REQUIRED'
        AND draft.needs_human = true
        AND draft.provider_metadata->>'provider' = 'disabled-llm'
        AND message.id = draft.conversation_message_id
        AND conversation.state = 'pending_review'
        AND message.direction = 'incoming'
        AND coalesce(message.metadata->>'providerMessageId', '') <> ''
      RETURNING draft.id, draft.conversation_message_id, draft.branch
    ), audited AS (
      INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
      SELECT conversation.workspace_id, NULL, 'setter.draft.reprocessed', 'setter_draft', updated.id::text,
             requested.audit_metadata
      FROM updated
      JOIN requested ON requested.draft_id = updated.id
      JOIN conversation_messages AS message ON message.id = updated.conversation_message_id
      JOIN conversations AS conversation ON conversation.id = message.conversation_id
      RETURNING entity_id
    )
    SELECT entity_id FROM audited;
  `;
}

async function persistReprocessedDrafts(prepared: PreparedDraft[]): Promise<void> {
  const db = getDb();
  const updated = await db.execute(buildPersistenceStatement(prepared));

  if (updated.rows.length !== prepared.length) {
    throw new Error("Draft rows were not updated; safety preconditions no longer hold.");
  }
  for (const { candidate } of prepared) {
    console.log(`Updated existing draft ${candidate.draft.id}; human review remains required.`);
  }
}

async function main(): Promise<void> {
  loadReprocessEnvironment();
  const args = parseReprocessArguments(process.argv.slice(2));
  if (process.env.AUTO_SEND?.toLowerCase() === "true" || process.env.DEFAULT_DELIVERY_MODE === "live") {
    throw new Error("Refusing to run while outbound delivery is enabled.");
  }

  const candidates = await findCandidates(args);
  const selection = selectAndValidateTargets(candidates, args);
  console.log(`TARGETS_REQUESTED=${selection.requested}`);
  console.log(`TARGETS_VALIDATED=${selection.validated}`);
  console.log(`TARGETS_ELIGIBLE=${selection.eligible.length}`);
  console.log(`TARGETS_SKIPPED_SUCCESSFUL=${selection.skippedSuccessful}`);
  if (!args.apply && !args.diagnose) {
    console.log(`PREVIEW_WOULD_TOUCH_DRAFTS=${selection.eligible.length}`);
    console.log("PREVIEW_WOULD_TOUCH_CONVERSATIONS=0");
    console.log("PREVIEW_WOULD_TOUCH_MESSAGES=0");
    console.log("PREVIEW_WOULD_SEND_EMAIL=NO");
    return;
  }
  if (selection.eligible.length === 0) {
    if (args.diagnose) {
      console.log("No eligible targets require diagnostic processing.");
      console.log("DB_WRITES=0");
      console.log("EMAILS_SENT=0");
      return;
    }
    console.log("No eligible drafts remain; successful reprocesses were skipped.");
    return;
  }

  let provider: ReturnType<typeof createSetterLLMProvider>;
  try {
    const intel = getIntelligenceEnv();
    provider = createSetterLLMProvider({
      ...intel,
      LLM_PROVIDER: "anthropic",
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
      CLAUDE_WORKSPACE_ID: process.env.CLAUDE_WORKSPACE_ID,
    }, "production");
  } catch (error) {
    if (!args.diagnose) throw error;
    for (const [index] of selection.eligible.entries()) {
      const diagnostic = createTargetDiagnostic();
      recordDiagnosticException(diagnostic, error);
      reportTargetDiagnostic(index + 1, diagnostic);
    }
    console.log("DB_WRITES=0");
    console.log("EMAILS_SENT=0");
    return;
  }

  if (args.diagnose) {
    for (const [index, candidate] of selection.eligible.entries()) {
      const diagnostic = createTargetDiagnostic();
      try {
        await prepareReprocess(candidate, diagnosticProvider(provider, diagnostic), diagnostic);
      } catch (error) {
        recordDiagnosticException(diagnostic, error);
      }
      reportTargetDiagnostic(index + 1, diagnostic);
    }
    console.log("DB_WRITES=0");
    console.log("EMAILS_SENT=0");
    return;
  }

  const prepared: PreparedDraft[] = [];
  for (const candidate of selection.eligible) prepared.push(await prepareReprocess(candidate, provider));
  await persistReprocessedDrafts(prepared);
  console.log(`ITEMS_REPROCESSED=${prepared.length}`);
  console.log("No webhook replay, message insert, conversation insert, or email send occurred.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Setter draft reprocessing failed.");
    process.exitCode = 1;
  });
}