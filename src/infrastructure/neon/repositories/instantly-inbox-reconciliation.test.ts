import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("drizzle-orm", () => {
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), {
    raw: (value: string) => value,
  });
  const expression = (kind: string) => (...values: unknown[]) => ({ kind, values });
  return {
    and: expression("and"),
    eq: (field: string, value: unknown) => ({ kind: "eq", field, value }),
    inArray: expression("inArray"),
    lt: expression("lt"),
    or: expression("or"),
    sql,
  };
});

vi.mock("@/infrastructure/neon/db", () => {
  const schema = new Proxy({}, {
    get: (_target, table) => new Proxy({ __table: String(table) }, {
      get: (target, field) => field === "__table" ? target.__table : `${target.__table}.${String(field)}`,
    }),
  });
  return { getDb: mocks.getDb, schema };
});

const { listConfiguredInstantlyCampaigns, dedupeConfiguredInstantlyCampaigns } = await import("./instantly-inbox-reconciliation");

function database() {
  const builder = (table?: { __table?: string }) => {
    let currentTable = table?.__table;
    const query = {
      from(value: { __table: string }) { currentTable = value.__table; return query; },
      where() { return query; },
      then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          return Promise.resolve(resolve(mocks.rows[currentTable ?? ""] ?? []));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
    };
    return query;
  };
  return {
    select: () => builder(),
    selectDistinct: () => builder(),
  };
}

describe("Instantly inbox campaign discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = {};
    mocks.getDb.mockReturnValue(database());
  });

  it("discovers the provider campaign used by successful Instantly imports", async () => {
    mocks.rows.instantlyLeadImports = [{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }];

    await expect(listConfiguredInstantlyCampaigns("workspace-1")).resolves.toEqual([
      { providerCampaignId: "provider-target", workspaceId: "workspace-1" },
    ]);
  });

  it("deduplicates mapping, engine-config, and import sources during discovery", async () => {
    mocks.rows.campaignProviderMappings = [{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }];
    mocks.rows.campaigns = [{ workspaceId: "workspace-1", engineConfig: { instantlyCampaignId: "provider-target" } }];
    mocks.rows.instantlyLeadImports = [{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }];

    await expect(listConfiguredInstantlyCampaigns("workspace-1")).resolves.toEqual([
      { providerCampaignId: "provider-target", workspaceId: "workspace-1" },
    ]);
  });

  it("deduplicates a provider campaign shared by multiple source campaigns without choosing one", () => {
    const targets = dedupeConfiguredInstantlyCampaigns(
      [{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }],
      [{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }],
      [{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }],
    );

    expect(targets).toEqual([{ providerCampaignId: "provider-target", workspaceId: "workspace-1" }]);
    expect(targets[0]).not.toHaveProperty("campaignId");
  });
});
