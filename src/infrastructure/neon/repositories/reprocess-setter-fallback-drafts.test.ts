import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildPersistenceStatement,
  parseReprocessArguments,
  setReprocessEnvironmentMode,
  selectAndValidateTargets,
  type Candidate,
  type PreparedDraft,
} from "../../../../scripts/reprocess-setter-fallback-drafts";

const draftIdA = "11111111-1111-4111-8111-111111111111";
const draftIdB = "22222222-2222-4222-8222-222222222222";
const draftIdC = "33333333-3333-4333-8333-333333333333";
const draftIds = [draftIdA, draftIdB, draftIdC];
const conversationIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const conversationIdC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const conversationIds = [conversationIdA, conversationIdB, conversationIdC];

function candidate(index: number, provider = "disabled-llm"): Candidate {
  const providerMessageId = `provider-message-${index}`;
  return {
    draft: {
      id: draftIds[index],
      branch: "HUMAN_REQUIRED",
      needsHuman: true,
      providerMetadata: provider === "anthropic-setter"
        ? { provider, model: "claude-sonnet-5-5", reprocessReason: "anthropic_provider_enabled" }
        : { provider },
    },
    message: {
      id: `message-${index}`,
      direction: "incoming",
      providerMessageId: `instantly:${providerMessageId}`,
      metadata: { eventType: "reply_received", providerMessageId, providerEventId: `event-${index}` },
    },
    conversation: { id: conversationIds[index], state: "pending_review" },
  } as Candidate;
}

function prepared(candidateRow: Candidate): PreparedDraft {
  return {
    candidate: candidateRow,
    output: {
      language: "es",
      branch: "HUMAN_REQUIRED",
      intentSummary: "Review required",
      confidence: 0.9,
      draft: "A non-empty review draft.",
      needsHuman: true,
      reasonForHuman: "Manual review required.",
      detectedFactsRequested: [],
      riskFlags: [],
      suggestedNextAction: "manual_human_draft",
    },
    providerMetadata: { provider: "anthropic-setter", model: "claude-sonnet-5-5" },
    auditMetadata: { provider: "anthropic-setter", needsHuman: true },
  } as PreparedDraft;
}

describe("guarded Setter fallback reprocessor", () => {
  it("forces production env-file loading when the launcher leaves NODE_ENV unset or non-production", () => {
    for (const initialMode of [undefined, "development"]) {
      const environment = { NODE_ENV: initialMode } as NodeJS.ProcessEnv;
      setReprocessEnvironmentMode(environment);
      expect(environment.NODE_ENV).toBe("production");
    }
  });

  it("refuses apply without explicit target identifiers", () => {
    expect(() => parseReprocessArguments(["--apply"])).toThrow(/explicit .*target/i);
  });

  it("accepts an explicit-ID preview and selects only the requested draft", () => {
    const args = parseReprocessArguments(["--draft-id", draftIdB]);
    const rows = [candidate(0), candidate(1), candidate(2)];
    const selection = selectAndValidateTargets(rows, args);

    expect(selection.requested).toBe(1);
    expect(selection.validated).toBe(1);
    expect(selection.eligible).toEqual([rows[1]]);
  });

  it("limits apply targets to the explicit IDs and ignores unrelated fallbacks", () => {
    const args = parseReprocessArguments(["--draft-id", draftIdA, "--apply"]);
    const rows = [candidate(0), candidate(1), candidate(2)];
    const selection = selectAndValidateTargets(rows, args);

    expect(args.apply).toBe(true);
    expect(selection.eligible).toEqual([rows[0]]);
  });

  it("skips a target that already has a successful Claude replacement", () => {
    const args = parseReprocessArguments(["--conversation-id", conversationIdB, "--apply"]);
    const selection = selectAndValidateTargets([candidate(1, "anthropic-setter")], args);

    expect(selection.validated).toBe(1);
    expect(selection.eligible).toHaveLength(0);
    expect(selection.skippedSuccessful).toBe(1);
  });

  it("persists only existing draft rows and audit entries, never conversations, messages, or email", () => {
    const statement = new PgDialect().sqlToQuery(buildPersistenceStatement([prepared(candidate(0))]));

    expect(statement.sql).toContain("UPDATE setter_drafts");
    expect(statement.sql).toContain("INSERT INTO audit_log");
    expect(statement.sql).not.toMatch(/(?:INSERT INTO|UPDATE) (?:conversations|conversation_messages)/i);
    expect(statement.sql).not.toMatch(/outbound|delivery|email_send/i);
  });
});