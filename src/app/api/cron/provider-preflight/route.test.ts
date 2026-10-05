import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  authorized: vi.fn(),
  getDatabaseEnv: vi.fn(),
  getDeliveryEnv: vi.fn(),
  getVerificationEnv: vi.fn(),
}));

vi.mock("@/infrastructure/neon/db", () => ({ getNeonSql: () => mocks.sql }));
vi.mock("@/lib/config/env", () => ({
  getDatabaseEnv: mocks.getDatabaseEnv,
  getDeliveryEnv: mocks.getDeliveryEnv,
  getVerificationEnv: mocks.getVerificationEnv,
}));
vi.mock("../_lib/cron-http", () => ({
  isAuthorizedCronRequest: mocks.authorized,
  unauthorizedCronResponse: () => Response.json({ status: "unauthorized" }, { status: 401 }),
}));

import { GET } from "./route";

const migrationFilenames = [
  "0013_global_deduplication.sql",
  "0014_setter_runtime.sql",
  "0015_email_verification_pipeline.sql",
  "0016_email_verification_cache_version.sql",
  "0017_instantly_lead_imports.sql",
];

const requiredIndexes = [
  "uq_instantly_import_identity",
  "uq_instantly_import_idempotency",
  "uq_instantly_import_email",
  "uq_instantly_import_active_account",
  "idx_instantly_import_dispatch",
  "idx_instantly_import_workspace_status",
];
const emptyHistoricalFunnel = {
  raw_autopilot_candidates: 0,
  canonical_accounts: 0,
  accounts_with_email: 0,
  campaign_memberships: 0,
  qualified: 0,
  ready: 0,
  selected_email: 0,
  unverified: 0,
  valid_cached: 0,
  invalid_cached: 0,
  missing_compliance: 0,
  compliance_allowed: 0,
  suppressed: 0,
  prior_outreach: 0,
  active_conversation: 0,
  eligible_for_verification: 0,
  eligible_for_instantly: 0,
};

function createFetchResponse(url: string): Response {
  if (url.includes("/api/v3/credits")) return Response.json({ credits: 987 });
  if (url.includes("/workspace-billing/plan-details")) {
    return Response.json({ subscriptions: { outreach: { current_lead_count: 912, total_lead_limit: 1200 } } });
  }
  if (url.includes("/campaigns/analytics")) return Response.json([{ emails_sent_count: 123 }]);
  if (url.includes("/workspace-billing/plan-details")) {
    return Response.json({ subscriptions: { outreach: { current_lead_count: 912, total_lead_limit: 1200 } } });
  }
  if (url.endsWith("/055534c5-c3e3-414f-b140-f4770b293c00")) {
    return Response.json({ id: "055534c5-c3e3-414f-b140-f4770b293c00" });
  }
  return Response.json({}, { status: 404 });
}

function configureReadyPreflight(
  fetchResponse: (url: string) => Response = createFetchResponse,
  appliedMigrations: readonly string[] = migrationFilenames,
) {
  mocks.authorized.mockReturnValue(true);
  mocks.getDatabaseEnv.mockReturnValue({ DATABASE_URL: "postgresql://db.test/vitalcap", DATABASE_URL_UNPOOLED: undefined });
  mocks.getVerificationEnv.mockReturnValue({
    EMAIL_VERIFICATION_PROVIDER: "millionverifier",
    MILLION_VERIFIER: "million-secret",
    MILLIONVERIFIER_API_KEY: undefined,
  });
  mocks.getDeliveryEnv.mockReturnValue({
    EMAIL_DELIVERY_PROVIDER: "instantly",
    INSTANTLY_API_KEY: "instantly-secret",
    INSTANTLY_CAMPAIGN_ID: "055534c5-c3e3-414f-b140-f4770b293c00",
    INSTANTLY_MAX_UPLOADED_CONTACTS: 1000,
    INSTANTLY_CONTACT_USAGE_WARNING_THRESHOLD: 900,
    INSTANTLY_MAX_MONTHLY_EMAILS: 5000,
    INSTANTLY_MONTHLY_EMAIL_WARNING_THRESHOLD: 4500,
  });
  mocks.sql.mockImplementation((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("to_regclass")) {
      return Promise.resolve([{
        migration_ledger: "vitalcap_migrations",
        instantly_lead_imports: "instantly_lead_imports",
        instantly_import_locks: "instantly_import_locks",
      }]);
    }
    if (query.includes("public.vitalcap_migrations")) {
      return Promise.resolve(appliedMigrations.map((filename) => ({ filename })));
    }
    if (query.includes("pg_indexes")) {
      return Promise.resolve(requiredIndexes.map((indexname) => ({ indexname })));
    }
    if (query.includes("raw_autopilot_candidates")) return Promise.resolve([emptyHistoricalFunnel]);
    throw new Error("Unexpected database query");
  });
  const fetchMock = vi.fn((input: RequestInfo | URL) => fetchResponse(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GET /api/cron/provider-preflight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires existing cron authorization before reading providers or the database", async () => {
    mocks.authorized.mockReturnValue(false);
    const response = await GET(new Request("https://vitalcap.test/api/cron/provider-preflight") as never);

    expect(response.status).toBe(401);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("performs non-consuming provider checks and reports migration state without secrets", async () => {
    const fetchMock = configureReadyPreflight();

    const response = await GET(new Request("https://vitalcap.test/api/cron/provider-preflight") as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      healthy: true,
      historicalFunnel: emptyHistoricalFunnel,
      database: {
        configured: true,
        healthy: true,
        through0016: true,
        through0017: true,
        migration0017Applied: true,
        instantlyTablesExist: true,
        requiredIndexesPresent: true,
      },
      millionVerifier: {
        configured: true,
        provider: "millionverifier",
        healthy: true,
        creditsAvailable: true,
        creditsRemaining: 987,
      },
      instantly: {
        configured: true,
        instantlyLeadImportReady: true,
        telemetryReady: true,
        campaignAccessible: true,
        campaignId: "055534c5-c3e3-414f-b140-f4770b293c00",
        auth: { leadsWrite: "NOT_TESTED", campaignRead: "PASS", analyticsRead: "PASS", billingRead: "PASS" },
        planUsage: {
          uploadedContacts: 912,
          contactLimit: 1000,
          monthlyEmailsSent: 123,
          monthlyEmailLimit: 5000,
        },
      },
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("https://api.millionverifier.com/api/v3/credits?api=million-secret");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("email="))).toBe(false);
    expect(JSON.stringify(body)).not.toContain("million-secret");
    expect(JSON.stringify(body)).not.toContain("instantly-secret");
  });

  it("reports migration 0016 ready independently when 0017 is not applied", async () => {
    configureReadyPreflight(createFetchResponse, migrationFilenames.slice(0, -1));

    const response = await GET(new Request("https://vitalcap.test/api/cron/provider-preflight") as never);
    const body = await response.json();

    expect(body.database).toMatchObject({
      through0016: true,
      through0017: false,
      migration0017Applied: false,
      instantlyTablesExist: true,
      missingMigrations: ["0017_instantly_lead_imports.sql"],
    });
  });

  it.each(["billing", "analytics"])("keeps lead import ready when %s scope is unavailable", async (unavailableScope) => {
    configureReadyPreflight((url) => {
      if ((unavailableScope === "billing" && url.includes("/workspace-billing/plan-details"))
        || (unavailableScope === "analytics" && url.includes("/campaigns/analytics"))) {
        return Response.json({ error: "scope missing" }, { status: 403 });
      }
      return createFetchResponse(url);
    });

    const response = await GET(new Request("https://vitalcap.test/api/cron/provider-preflight") as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      healthy: true,
      instantlyLeadImportReady: true,
      instantlyTelemetryReady: false,
      instantly: {
        instantlyLeadImportReady: true,
        telemetryReady: false,
        auth: {
          leadsWrite: "NOT_TESTED",
          campaignRead: "PASS",
          analyticsRead: unavailableScope === "analytics" ? "OPTIONAL_FAIL" : "PASS",
          billingRead: unavailableScope === "billing" ? "OPTIONAL_FAIL" : "PASS",
        },
      },
    });
  });

  it("reports a runtime Instantly 401 as unauthorized without exposing provider details", async () => {
    mocks.authorized.mockReturnValue(true);
    mocks.getDatabaseEnv.mockReturnValue({ DATABASE_URL: "postgresql://db.test/vitalcap" });
    mocks.getVerificationEnv.mockReturnValue({ EMAIL_VERIFICATION_PROVIDER: "disabled" });
    mocks.getDeliveryEnv.mockReturnValue({
      EMAIL_DELIVERY_PROVIDER: "instantly",
      INSTANTLY_API_KEY: "instantly-secret",
      INSTANTLY_CAMPAIGN_ID: "055534c5-c3e3-414f-b140-f4770b293c00",
      INSTANTLY_MAX_UPLOADED_CONTACTS: 1000,
      INSTANTLY_CONTACT_USAGE_WARNING_THRESHOLD: 900,
      INSTANTLY_MAX_MONTHLY_EMAILS: 5000,
      INSTANTLY_MONTHLY_EMAIL_WARNING_THRESHOLD: 4500,
    });
    mocks.sql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("to_regclass")) return Promise.resolve([{ migration_ledger: null }]);
      throw new Error("Unexpected database query");
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(url.includes("api.instantly.ai")
        ? Response.json({ error: "private provider detail" }, { status: 401 })
        : Response.json({ credits: 100 }));
    }));

    const response = await GET(new Request("https://vitalcap.test/api/cron/provider-preflight") as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.instantly).toMatchObject({
      auth: {
        leadsWrite: "NOT_TESTED",
        campaignRead: "FAIL",
        analyticsRead: "OPTIONAL_FAIL",
        billingRead: "OPTIONAL_FAIL",
      },
    });
    expect(JSON.stringify(body)).not.toContain("instantly-secret");
    expect(JSON.stringify(body)).not.toContain("private provider detail");
  });
});