import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  db: null as any,
  failOutreachQueueInsertOnce: false,
}));

vi.mock("drizzle-orm", () => {
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), {
    raw: (value: string) => value,
  });
  const expression = (kind: string) => (...values: unknown[]) => ({ kind, values });
  return {
    and: expression("and"),
    desc: expression("desc"),
    eq: (field: string, value: unknown) => ({ kind: "eq", field, value }),
    inArray: expression("inArray"),
    lt: expression("lt"),
    or: expression("or"),
    sql,
  };
});

vi.mock("@/infrastructure/neon/db", () => {
  const table = (name: string) => new Proxy({ __table: name }, {
    get(target, key) {
      return key === "__table" ? target.__table : `${name}.${String(key)}`;
    },
  });
  const schema = new Proxy({}, { get: (_target, key) => table(String(key)) });
  return { getDb: mocks.getDb, schema };
});

vi.mock("./accounts", () => ({ listAccountBundles: vi.fn() }));
vi.mock("./campaigns", () => ({ getCampaignById: vi.fn() }));
vi.mock("./offers", () => ({ getOfferById: vi.fn() }));
vi.mock("./outreach", () => ({ listSuppressionEntries: vi.fn() }));
vi.mock("./audit", () => ({ insertAuditLog: vi.fn() }));
vi.mock("./conversations", () => ({ toConversation: vi.fn(), toDraft: vi.fn(), toFeedback: vi.fn(), toMessage: vi.fn() }));
vi.mock("@/infrastructure/providers/instantly/reply-provider", () => ({ InstantlyReplyApiError: class {}, InstantlyReplyProvider: class {} }));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv: vi.fn(() => ({})) }));
vi.mock("@/services/setter/inbound-runtime", () => ({
  SetterInboundRoutingError: class extends Error {},
}));

const { neonSetterInboundRuntimeStore, persistSetterReviewDecision, processInstantlySentEvent } = await import("./setter-runtime");

function createDatabase() {
  let eventStatus: string | null = null;
  let eventErrorCode: string | null = null;
  let outreachQueueRows = new Map<string, any>();
  let outreachEventIds = new Set<string>();
  const calls: Array<{ operation: string; table: string; values?: any }> = [];
  const execute = vi.fn(async (_statement: { strings: readonly string[]; values: readonly unknown[] }) => ({ rows: [{ id: "feedback-1" }] }));

  function builder(operation: string, initialTable?: any) {
    const state: any = { operation, table: initialTable?.__table, values: undefined, returning: false };
    const current = {
      from(table: any) { state.table = table.__table; return current; },
      values(values: any) { state.values = values; return current; },
      set(values: any) { state.values = values; return current; },
      where(condition: any) { state.condition = condition; return current; },
      limit() { return current; },
      orderBy() { return current; },
      onConflictDoNothing() { return current; },
      returning() { state.returning = true; return current; },
      then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          calls.push({ operation, table: state.table, values: state.values });
          let result: any[] = [];
          if (operation === "select") {
            if (state.table === "campaigns") result = [{ id: "campaign-1", workspaceId: "workspace-1" }];
            if (state.table === "contactPoints") result = [{ id: "point-1", accountId: "account-1", contactId: "contact-1" }];
            if (state.table === "outreachQueue") {
              const id = state.values?.[0]?.values?.id;
              result = id && outreachQueueRows.has(id) ? [{ id }] : [];
            }
            if (state.table === "outreachEvents") {
              const id = state.values?.[0]?.values?.providerEventId;
              result = id && outreachEventIds.has(id) ? [{ outreachQueueItemId: state.values[0].values.outreachQueueItemId }] : [];
            }
          } else if (operation === "insert" && state.table === "setterWebhookEvents") {
            if (eventStatus === null) {
              eventStatus = "processing";
              result = [{ id: "webhook-1" }];
            }
          } else if (operation === "insert" && state.table === "outreachQueue") {
            if (mocks.failOutreachQueueInsertOnce) {
              mocks.failOutreachQueueInsertOnce = false;
              throw new Error("simulated partial failure");
            }
            const values = state.values;
            if (!outreachQueueRows.has(values.id)) outreachQueueRows.set(values.id, values);
            result = [{ id: values.id }];
          } else if (operation === "insert" && state.table === "outreachEvents") {
            const values = state.values;
            if (!outreachEventIds.has(values.providerEventId)) {
              outreachEventIds.add(values.providerEventId);
              result = [{ id: "outreach-event-1" }];
            }
          } else if (operation === "update" && state.table === "setterWebhookEvents") {
            const comparisons: Array<[string, unknown]> = [];
            const collect = (condition: any) => {
              if (Array.isArray(condition)) {
                for (const child of condition) collect(child);
                return;
              }
              if (condition?.kind === "eq") comparisons.push([condition.field, condition.value]);
              if (Array.isArray(condition?.values)) {
                for (const child of condition.values) collect(child);
              }
            };
            collect(state.condition);
            const allowsUnknownCampaignRetry = comparisons.some(([field, value]) => field === "setterWebhookEvents.status" && value === "ignored")
              && comparisons.some(([field, value]) => field === "setterWebhookEvents.errorCode" && value === "UNKNOWN_CAMPAIGN");
            const allowsFailedRetry = comparisons.some(([field, value]) => field === "setterWebhookEvents.status" && value === "failed");
            if (state.returning && (eventStatus === "failed" && allowsFailedRetry
              || eventStatus === "ignored" && allowsUnknownCampaignRetry && eventErrorCode === "UNKNOWN_CAMPAIGN")) {
              eventStatus = "processing";
              eventErrorCode = null;
              result = [{ id: "webhook-1" }];
            } else if (!state.returning && state.values?.status) {
              eventStatus = state.values.status;
              eventErrorCode = state.values.errorCode ?? eventErrorCode;
            }
          }
          return Promise.resolve(resolve(result));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
    };
    return current;
  }

  const db = {
    execute,
    select: () => builder("select"),
    insert: (table: any) => builder("insert", table),
    update: (table: any) => builder("update", table),
    transaction: vi.fn(() => { throw new Error("interactive transaction invoked"); }),
  };
  return {
    db,
    calls,
    setWebhookEvent(status: string, errorCode: string | null) { eventStatus = status; eventErrorCode = errorCode; },
    get eventStatus() { return eventStatus; },
    get outreachQueueRows() { return outreachQueueRows; },
    get outreachEventIds() { return outreachEventIds; },
  };
}

const sentEvent = {
  providerEventId: "sent-event-1",
  providerMessageId: "lead-1",
  providerCampaignId: "provider-campaign-1",
  email: "person@example.com",
  occurredAt: "2026-10-06T12:00:00.000Z",
  payloadHash: "payload-hash",
};

describe("Instantly webhook persistence", () => {
  let state: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failOutreachQueueInsertOnce = false;
    state = createDatabase();
    mocks.getDb.mockReturnValue(state.db);
  });

  it("processes email_sent once and skips a duplicate providerEventId", async () => {
    await expect(processInstantlySentEvent(sentEvent)).resolves.toEqual({ outcome: "processed" });
    await expect(processInstantlySentEvent(sentEvent)).resolves.toEqual({ outcome: "duplicate_skipped" });

    expect(state.outreachQueueRows.size).toBe(1);
    expect(state.outreachEventIds).toEqual(new Set([sentEvent.providerEventId]));
    expect(state.calls.filter((call) => call.operation === "insert" && call.table === "outreachEvents")).toHaveLength(1);
    expect(state.db.transaction).not.toHaveBeenCalled();
  });

  it("converges after a partial write failure when the same event is retried", async () => {
    mocks.failOutreachQueueInsertOnce = true;
    await expect(processInstantlySentEvent(sentEvent)).rejects.toThrow("simulated partial failure");
    expect(state.eventStatus).toBe("failed");

    await expect(processInstantlySentEvent(sentEvent)).resolves.toEqual({ outcome: "processed" });
    expect(state.outreachQueueRows.size).toBe(1);
    expect(state.outreachEventIds).toEqual(new Set([sentEvent.providerEventId]));
    expect(state.eventStatus).toBe("processed");
    expect(state.db.transaction).not.toHaveBeenCalled();
  });

  it("reclaims only ignored UNKNOWN_CAMPAIGN events and rejects a replay after reclaim", async () => {
    state.setWebhookEvent("ignored", "UNKNOWN_CAMPAIGN");
    const event = {
      eventType: "reply_received" as const,
      providerEventId: "missed-reply-event",
      providerMessageId: "missed-reply-message",
      providerThreadId: "missed-reply-thread",
      providerCampaignId: "provider-campaign-1",
      email: "person@example.com",
      subject: "Question",
      body: "Hello",
      occurredAt: "2026-10-06T12:00:00.000Z",
    };

    await expect(neonSetterInboundRuntimeStore.claimWebhookEvent(event, "hash")).resolves.toBe(true);
    expect(state.eventStatus).toBe("processing");
    await expect(neonSetterInboundRuntimeStore.claimWebhookEvent(event, "hash")).resolves.toBe(false);

    state.setWebhookEvent("ignored", "INVALID_PAYLOAD");
    await expect(neonSetterInboundRuntimeStore.claimWebhookEvent({ ...event, providerEventId: "other-event" }, "hash")).resolves.toBe(false);
    expect(state.eventStatus).toBe("ignored");
  });

  it("keeps webhook persistence methods free of interactive transactions", () => {
    const source = readFileSync(new URL("./setter-runtime.ts", import.meta.url), "utf8");
    for (const name of ["persistIncoming", "persistResult", "persistFailure", "processInstantlyComplianceEvent", "processInstantlySentEvent"]) {
      const start = source.indexOf(`${name}(`);
      expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
      const nextExport = source.indexOf("\nexport ", start + 1);
      const body = source.slice(start, nextExport === -1 ? source.length : nextExport);
      expect(body, `${name} avoids transaction()`).not.toContain(".transaction(");
    }

    const incomingStart = source.indexOf("async function persistIncoming(");
    const incomingEnd = source.indexOf("\nexport const neonSetterInboundRuntimeStore", incomingStart);
    const incoming = source.slice(incomingStart, incomingEnd);
    expect(incoming).toContain("eq(schema.conversationMessages.providerMessageId, messageId)");
    expect(incoming).toContain("eq(schema.conversations.providerThreadId, threadId)");
    expect(incoming).toContain(".onConflictDoNothing()");
    expect(incoming).toContain('.set({ state: "reply_received", updatedAt: receivedAt })');

    const resultStart = source.indexOf("async persistResult(");
    const resultEnd = source.indexOf("async persistFailure(", resultStart);
    expect(source.slice(resultStart, resultEnd)).toContain("schema.setterDrafts");
    expect(source.slice(resultStart, resultEnd)).toContain("schema.suppressionEntries");
    expect(source.slice(resultStart, resultEnd)).toContain(".onConflictDoNothing()");
  });

  it.each([
    ["approve", "approved_pending_send"],
    ["reject", "rejected"],
  ] as const)("persists %s atomically without a Neon HTTP transaction", async (decision, nextState) => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const messageId = "00000000-0000-4000-8000-000000000002";
    const item = {
      conversation: { id: "00000000-0000-4000-8000-000000000003" },
      draft: { id: "00000000-0000-4000-8000-000000000004" },
    } as any;
    const result = {
      conversation: { state: nextState, latestIntent: "PRICE", updatedAt: "2026-10-08T12:00:00.000Z" },
      feedback: {
        conversationMessageId: messageId,
        predictedBranch: "PRICE",
        correctedBranch: null,
        aiDraft: "Draft",
        correctedText: null,
        finalText: decision === "approve" ? "Draft" : null,
        decision,
        reasonCategory: null,
        note: null,
        meetingOutcome: null,
        qualified: null,
        lostReason: null,
        reviewedAt: "2026-10-08T12:00:00.000Z",
        reviewerId: "reviewer-1",
      },
    } as any;

    await expect(persistSetterReviewDecision(workspaceId, item, result)).resolves.toBe(true);

    expect(state.db.execute).toHaveBeenCalledTimes(1);
    expect(state.db.transaction).not.toHaveBeenCalled();
    const statement = state.db.execute.mock.calls[0]![0];
    expect(statement.strings.join(" ")).toContain("FOR UPDATE OF conversation");
    expect(statement.strings.join(" ")).toContain("ON CONFLICT (conversation_message_id) DO NOTHING");
    expect(statement.values).toContain(workspaceId);
    expect(statement.values).toContain(item.draft.id);
    expect(statement.values).toContain(messageId);
  });
});