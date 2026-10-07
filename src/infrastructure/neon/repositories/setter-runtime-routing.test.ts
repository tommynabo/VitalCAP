import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getAccountById: vi.fn(),
  getContactById: vi.fn(),
  listAccountBundles: vi.fn(),
  getCampaignById: vi.fn(),
  getOfferById: vi.fn(),
  listSuppressionEntries: vi.fn(),
  importRows: [] as any[],
  mappingRows: [] as any[],
  legacyRows: [] as any[],
  contactPointRows: [] as any[],
  memberships: [] as any[],
  accountSources: [] as any[],
  queryTables: [] as string[],
}));

vi.mock("drizzle-orm", () => {
  const expression = (kind: string) => (...values: unknown[]) => ({ kind, values });
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: "sql", strings, values }), {
    raw: (value: string) => value,
  });
  return {
    and: expression("and"),
    desc: expression("desc"),
    eq: (field: string, value: unknown) => ({ kind: "eq", field, value }),
    inArray: (field: string, values: unknown[]) => ({ kind: "inArray", field, values }),
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
  listAccountBundles: mocks.listAccountBundles,
  toContactPoint: (row: unknown) => row,
}));
vi.mock("./campaigns", () => ({ getCampaignById: mocks.getCampaignById }));
vi.mock("./offers", () => ({ getOfferById: mocks.getOfferById }));
vi.mock("./outreach", () => ({ listSuppressionEntries: mocks.listSuppressionEntries }));
vi.mock("./audit", () => ({ insertAuditLog: vi.fn() }));
vi.mock("./conversations", () => ({ toConversation: vi.fn(), toDraft: vi.fn(), toFeedback: vi.fn(), toMessage: vi.fn() }));
vi.mock("@/infrastructure/providers/instantly/reply-provider", () => ({ InstantlyReplyApiError: class {}, InstantlyReplyProvider: class {} }));
vi.mock("@/lib/config/env", () => ({ getDeliveryEnv: vi.fn(() => ({})) }));
vi.mock("@/services/setter/inbound-runtime", () => ({
  SetterInboundRoutingError: class extends Error {
    constructor(readonly code: string, readonly workspaceId: string | null = null) {
      super(code);
    }
  },
}));

const { resolveInboundContext } = await import("./setter-runtime");

function comparisonValue(condition: any, field: string): unknown {
  if (!condition || typeof condition !== "object") return undefined;
  if (condition.kind === "eq" && condition.field === field) return condition.value;
  if (condition.kind === "inArray" && condition.field === field) return condition.values;
  for (const value of condition.values ?? []) {
    const result = comparisonValue(value, field);
    if (result !== undefined) return result;
  }
  return undefined;
}

function createDatabase() {
  function builder(tableName?: string) {
    const state: { table?: string; where?: any; limit?: number } = { table: tableName };
    const current = {
      from(table: any) { state.table = table.__table; return current; },
      where(condition: any) { state.where = condition; return current; },
      limit(value: number) { state.limit = value; return current; },
      then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          const table = state.table ?? "";
          mocks.queryTables.push(table);
          let rows: any[] = [];
          if (table === "instantlyLeadImports") {
            const providerCampaignId = comparisonValue(state.where, "instantlyLeadImports.providerCampaignId");
            const normalizedEmail = comparisonValue(state.where, "instantlyLeadImports.normalizedEmail");
            const statuses = comparisonValue(state.where, "instantlyLeadImports.status") as string[] | undefined;
            rows = mocks.importRows.filter((row) => row.providerCampaignId === providerCampaignId
              && row.normalizedEmail === normalizedEmail && statuses?.includes(row.status));
          } else if (table === "campaignProviderMappings") {
            const provider = comparisonValue(state.where, "campaignProviderMappings.provider");
            const providerCampaignId = comparisonValue(state.where, "campaignProviderMappings.providerCampaignId");
            const enabled = comparisonValue(state.where, "campaignProviderMappings.enabled");
            rows = mocks.mappingRows.filter((row) => row.provider === provider
              && row.providerCampaignId === providerCampaignId && row.enabled === enabled);
          } else if (table === "campaigns") {
            rows = mocks.legacyRows;
          } else if (table === "contactPoints") {
            rows = mocks.contactPointRows.filter((row) => ["id", "workspaceId", "accountId", "type", "normalizedValue"]
              .every((key) => comparisonValue(state.where, `contactPoints.${key}`) === row[key]));
          } else if (table === "campaignMemberships") {
            rows = mocks.memberships.filter((row) => row.campaignId === comparisonValue(state.where, "campaignMemberships.campaignId")
              && row.accountId === comparisonValue(state.where, "campaignMemberships.accountId"));
          } else if (table === "accountSources") {
            rows = mocks.accountSources;
          }
          return Promise.resolve(resolve(state.limit ? rows.slice(0, state.limit) : rows));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
    };
    return current;
  }
  return { select: () => builder(), insert: () => builder(), update: () => builder() };
}

const campaignA = { id: "campaign-a", workspaceId: "workspace-a", offerId: "offer-a" };
const campaignB = { id: "campaign-b", workspaceId: "workspace-a", offerId: "offer-a" };
const accountA = { id: "account-a", workspaceId: "workspace-a" };
const accountB = { id: "account-b", workspaceId: "workspace-a" };
const providerCampaignId = "shared-instantly-campaign";

const eventA = { providerCampaignId, email: "a@example.com" } as any;
const eventB = { providerCampaignId, email: "b@example.com" } as any;

function importedRow(email: string, campaignId: string, accountId: string, status: string) {
  return {
    workspaceId: "workspace-a",
    sourceCampaignId: campaignId,
    accountId,
    contactId: null,
    contactPointId: `point-${accountId}`,
    providerCampaignId,
    normalizedEmail: email,
    status,
  };
}

function setupImportedIdentityRows() {
  mocks.importRows = [
    importedRow(eventA.email, campaignA.id, accountA.id, "instantly_added"),
    importedRow(eventB.email, campaignB.id, accountB.id, "skipped_existing"),
    importedRow(eventA.email, campaignB.id, accountB.id, "eligible"),
  ];
  mocks.mappingRows = [
    { campaignId: campaignA.id, workspaceId: "workspace-a", provider: "instantly", providerCampaignId, enabled: true },
    { campaignId: campaignB.id, workspaceId: "workspace-a", provider: "instantly", providerCampaignId, enabled: true },
  ];
  mocks.contactPointRows = [
    { id: "point-account-a", workspaceId: "workspace-a", accountId: accountA.id, type: "email", normalizedValue: eventA.email, contactId: null },
    { id: "point-account-b", workspaceId: "workspace-a", accountId: accountB.id, type: "email", normalizedValue: eventB.email, contactId: null },
  ];
  mocks.memberships = [
    { campaignId: campaignA.id, accountId: accountA.id, contactId: null },
    { campaignId: campaignB.id, accountId: accountB.id, contactId: null },
  ];
}

describe("Instantly inbound campaign routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importRows = [];
    mocks.mappingRows = [];
    mocks.legacyRows = [];
    mocks.contactPointRows = [];
    mocks.memberships = [];
    mocks.accountSources = [];
    mocks.queryTables = [];
    mocks.getDb.mockReturnValue(createDatabase());
    mocks.getCampaignById.mockImplementation(async (id: string) => [campaignA, campaignB].find((campaign) => campaign.id === id) ?? null);
    mocks.getOfferById.mockResolvedValue({ id: "offer-a" });
    mocks.getAccountById.mockImplementation(async (id: string) => [accountA, accountB].find((account) => account.id === id) ?? null);
    mocks.getContactById.mockResolvedValue(null);
    mocks.listAccountBundles.mockResolvedValue([]);
    mocks.listSuppressionEntries.mockResolvedValue([]);
  });

  it("routes each reply by its imported email when two campaigns share the provider campaign", async () => {
    setupImportedIdentityRows();

    const resolvedA = await resolveInboundContext(eventA);
    const resolvedB = await resolveInboundContext(eventB);

    expect(resolvedA).toMatchObject({ campaignId: campaignA.id, accountId: accountA.id, context: { contactPointId: "point-account-a" } });
    expect(resolvedB).toMatchObject({ campaignId: campaignB.id, accountId: accountB.id, context: { contactPointId: "point-account-b" } });
    expect(mocks.queryTables).not.toContain("campaignProviderMappings");
    expect(mocks.listAccountBundles).not.toHaveBeenCalled();
  });

  it("uses one enabled canonical mapping when no safe import identity matches", async () => {
    mocks.mappingRows = [{ campaignId: campaignA.id, workspaceId: "workspace-a", provider: "instantly", providerCampaignId, enabled: true }];
    mocks.listAccountBundles.mockResolvedValue([{
      account: accountA,
      contacts: [],
      sources: [],
      contactPoints: [{ id: "point-account-a", type: "email", normalizedValue: eventA.email, contactId: null }],
    }]);
    mocks.memberships = [{ campaignId: campaignA.id, accountId: accountA.id, contactId: null }];

    const resolved = await resolveInboundContext(eventA);

    expect(resolved).toMatchObject({ campaignId: campaignA.id, accountId: accountA.id });
    expect(mocks.queryTables).toContain("campaignProviderMappings");
  });

  it("fails closed when multiple safe import identities match one reply", async () => {
    setupImportedIdentityRows();
    mocks.importRows.push(importedRow(eventA.email, campaignB.id, accountB.id, "skipped_existing"));

    await expect(resolveInboundContext(eventA)).rejects.toMatchObject({ code: "AMBIGUOUS_CAMPAIGN" });
    expect(mocks.getCampaignById).not.toHaveBeenCalled();
  });
});