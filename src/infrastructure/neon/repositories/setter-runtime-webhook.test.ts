import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getAccountById: vi.fn(),
  getContactById: vi.fn(),
  getCampaignById: vi.fn(),
  getOfferById: vi.fn(),
  db: null as any,
  failOutreachQueueInsertOnce: false,
  importRows: [] as any[],
  contactPointRows: [] as any[],
  membershipRows: [] as any[],
  accountSourceRows: [] as any[],
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

vi.mock("./accounts", () => ({
  getAccountById: mocks.getAccountById,
  getContactById: mocks.getContactById,
  listAccountBundles: vi.fn(),
  toContactPoint: (row: unknown) => row,
}));
vi.mock("./campaigns", () => ({ getCampaignById: mocks.getCampaignById }));
vi.mock("./offers", () => ({ getOfferById: mocks.getOfferById }));
vi.mock("./outreach", () => ({ listSuppressionEntries: vi.fn(async () => []) }));
vi.mock("./audit", () => ({ insertAuditLog: vi.fn() }));
vi.mock("./conversations", () => ({ toConversation: vi.fn(), toDraft: vi.fn(), toFeedback: vi.fn(), toMessage: vi.fn() }));
vi.mock("@/infrastructure/providers/instantly/reply-provider", () => ({ InstantlyReplyApiError: class {}, InstantlyReplyProvider: class {} }));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv: vi.fn(() => ({})) }));
vi.mock("@/services/setter/inbound-runtime", () => ({
  SetterInboundRoutingError: class extends Error {},
}));

const { neonSetterInboundRuntimeStore, persistSetterReviewDecision, processInstantlySentEvent, resolveInboundContext } = await import("./setter-runtime");

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
            if (state.table === "instantlyLeadImports") {
              const comparisons = new Map<string, unknown>();
              const collect = (condition: any) => {
                if (Array.isArray(condition)) {
                  for (const child of condition) collect(child);
                } else if (condition?.kind === "eq") {
                  comparisons.set(condition.field, condition.value);
                } else if (Array.isArray(condition?.values)) {
                  for (const child of condition.values) collect(child);
                }
              };
              collect(state.condition);
              result = mocks.importRows.filter((row) =>
                row.providerCampaignId === comparisons.get("instantlyLeadImports.providerCampaignId")
                && row.normalizedEmail === comparisons.get("instantlyLeadImports.normalizedEmail"),
              );
            }
            if (state.table === "contactPoints") {
              const comparisons = new Map<string, unknown>();
              const collect = (condition: any) => {
                if (Array.isArray(condition)) {
                  for (const child of condition) collect(child);
                } else if (condition?.kind === "eq") {
                  comparisons.set(condition.field, condition.value);
                } else if (Array.isArray(condition?.values)) {
                  for (const child of condition.values) collect(child);
                }
              };
              collect(state.condition);
              result = mocks.contactPointRows.length > 0
                ? mocks.contactPointRows.filter((row) => row.id === comparisons.get("contactPoints.id")
                  && row.normalizedValue === comparisons.get("contactPoints.normalizedValue"))
                : [{ id: "point-1", accountId: "account-1", contactId: "contact-1" }];
            }
            if (state.table === "campaignMemberships") {
              const comparisons = new Map<string, unknown>();
              const collect = (condition: any) => {
                if (Array.isArray(condition)) {
                  for (const child of condition) collect(child);
                } else if (condition?.kind === "eq") {
                  comparisons.set(condition.field, condition.value);
                } else if (Array.isArray(condition?.values)) {
                  for (const child of condition.values) collect(child);
                }
              };
              collect(state.condition);
              result = mocks.membershipRows.filter((row) => row.campaignId === comparisons.get("campaignMemberships.campaignId")
                && row.accountId === comparisons.get("campaignMemberships.accountId"));
            }
            if (state.table === "accountSources") result = mocks.accountSourceRows;
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
    mocks.importRows = [];
    mocks.contactPointRows = [];
    mocks.membershipRows = [];
    mocks.accountSourceRows = [];
    mocks.getAccountById.mockReset();
    mocks.getContactById.mockReset();
    mocks.getCampaignById.mockReset();
    mocks.getOfferById.mockReset();
    mocks.getAccountById.mockImplementation(async (id: string) => ({ id, workspaceId: "workspace-1" }));
    mocks.getContactById.mockImplementation(async (id: string) => ({ id, workspaceId: "workspace-1", accountId: "account-1" }));
    mocks.getCampaignById.mockImplementation(async (id: string) => ({ id, workspaceId: "workspace-1", offerId: "offer-1" }));
    mocks.getOfferById.mockResolvedValue({ id: "offer-1" });
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
    for (const name of ["persistIncoming", "persistResult", "persistFailure", "processInstantlyComplianceEvent", "processInstantlySentEvent", "sendReviewedSetterReply", "recordReplySendFailure"]) {
      const start = source.indexOf(`${name}(`);
      expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
      const nextExport = source.indexOf("\nexport ", start + 1);
      const body = source.slice(start, nextExport === -1 ? source.length : nextExport);
      expect(body, `${name} avoids transaction()`).not.toContain(".transaction(");
    }

    const senderStart = source.indexOf("export async function sendReviewedSetterReply(");
    const senderEnd = source.indexOf("\nasync function recordReplySendFailure(", senderStart);
    const sender = source.slice(senderStart, senderEnd);
    expect(sender).toContain("conversation.state = 'approved_pending_send'");
    expect(sender).toContain("IS DISTINCT FROM 'send_unknown'");
    expect(sender).toContain("UPDATE conversation_messages AS message");

    const incomingStart = source.indexOf("async function persistIncoming(");
    const incomingEnd = source.indexOf("\nexport const neonSetterInboundRuntimeStore", incomingStart);
    const incoming = source.slice(incomingStart, incomingEnd);
    expect(incoming).toContain("eq(schema.conversationMessages.providerMessageId, messageId)");
    expect(incoming).toContain("eq(schema.conversations.providerThreadId, threadId)");
    expect(incoming).toContain("replyToUuid: event.replyToUuid ?? event.providerMessageId");
    expect(incoming).toContain("emailAccount: event.emailAccount ?? null");
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

describe("Instantly inbound import identity routing", () => {
  beforeEach(() => {
    mocks.getDb.mockReturnValue(createDatabase().db);
  });

  it("routes a shared provider campaign by exact lead identity to each imported source campaign", async () => {
    const campaignA = { id: "source-campaign-a", workspaceId: "workspace-1", offerId: "offer-1" };
    const campaignB = { id: "source-campaign-b", workspaceId: "workspace-1", offerId: "offer-1" };
    const accountA = { id: "account-a", workspaceId: "workspace-1" };
    const accountB = { id: "account-b", workspaceId: "workspace-1" };
    mocks.importRows = [
      { providerCampaignId: "provider-shared", normalizedEmail: "a@example.com", workspaceId: "workspace-1", sourceCampaignId: campaignA.id, accountId: accountA.id, contactId: "contact-a", contactPointId: "point-a", status: "instantly_added" },
      { providerCampaignId: "provider-shared", normalizedEmail: "b@example.com", workspaceId: "workspace-1", sourceCampaignId: campaignB.id, accountId: accountB.id, contactId: "contact-b", contactPointId: "point-b", status: "instantly_added" },
    ];
    mocks.contactPointRows = [
      { id: "point-a", workspaceId: "workspace-1", accountId: accountA.id, type: "email", normalizedValue: "a@example.com", value: "a@example.com", contactId: "contact-a" },
      { id: "point-b", workspaceId: "workspace-1", accountId: accountB.id, type: "email", normalizedValue: "b@example.com", value: "b@example.com", contactId: "contact-b" },
    ];
    mocks.membershipRows = [
      { campaignId: campaignA.id, accountId: accountA.id, contactId: "contact-a" },
      { campaignId: campaignB.id, accountId: accountB.id, contactId: "contact-b" },
    ];
    mocks.getCampaignById.mockImplementation(async (id: string) => id === campaignA.id ? campaignA : campaignB);
    mocks.getOfferById.mockResolvedValue({ id: "offer-1" });
    mocks.getAccountById.mockImplementation(async (id: string) => id === accountA.id ? accountA : accountB);
    mocks.getContactById.mockImplementation(async (id: string) => ({ id, workspaceId: "workspace-1", accountId: id === "contact-a" ? accountA.id : accountB.id }));

    const event = (email: string) => ({ providerCampaignId: "provider-shared", email } as any);
    const resultA = await resolveInboundContext(event("a@example.com"));
    const resultB = await resolveInboundContext(event("b@example.com"));

    expect(resultA).toMatchObject({ campaignId: campaignA.id, accountId: accountA.id, contactId: "contact-a" });
    expect(resultB).toMatchObject({ campaignId: campaignB.id, accountId: accountB.id, contactId: "contact-b" });
  });
});