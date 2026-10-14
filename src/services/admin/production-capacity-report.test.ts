import { describe, expect, it } from "vitest";
import { assertNeonDatabaseIdentity } from "../../../scripts/neon-database-identity";
import {
  applyProductionConfiguration,
  assertReadOnlyTransaction,
  formatCapacityReport,
  readOnlyTransactionOptions,
} from "../../../scripts/autopilot-capacity-report";

describe("read-only capacity report", () => {
  it("forces the Neon transaction read-only option and rejects an unverified transaction", () => {
    expect(readOnlyTransactionOptions({ arrayMode: true, fullResults: true })).toEqual({
      arrayMode: true,
      fullResults: true,
      readOnly: true,
    });
    expect(() => assertReadOnlyTransaction("off")).toThrow("READ_ONLY_TRANSACTION_NOT_ENFORCED");
    expect(() => assertReadOnlyTransaction("on")).not.toThrow();
  });

  it("accepts only a Neon URL using the configured endpoint", () => {
    expect(() => assertNeonDatabaseIdentity(
      "postgresql://readonly:secret@ep-vitalcap-prod-123-pooler.c-12.aws.neon.tech/neondb",
      "ep-vitalcap-prod-123.c-12.aws.neon.tech",
    )).not.toThrow();
    expect(() => assertNeonDatabaseIdentity(
      "postgresql://readonly:secret@ep-another-project-456-pooler.c-12.aws.neon.tech/neondb",
      "ep-vitalcap-prod-123.c-12.aws.neon.tech",
    )).toThrow("PRODUCTION_NEON_HOST_MISMATCH");
    expect(() => assertNeonDatabaseIdentity(
      "postgresql://readonly:secret@ep-vitalcap-prod-123.c-12.aws.neon.tech/neondb",
      undefined,
    )).toThrow("PRODUCTION_NEON_HOST_UNAVAILABLE");
  });

  it("uses Production guard overrides without copying secret variables", () => {
    const environment: Record<string, string | undefined> = {
      APIFY_DAILY_COST_LIMIT_USD: "15",
      DATABASE_URL: "local-placeholder",
    };
    applyProductionConfiguration(environment, {}, {
      APIFY_DAILY_COST_LIMIT_USD: "5",
      ACTIVATION_MAX_DAILY_RAW_REQUESTS: "1500",
      DATABASE_URL: "[SENSITIVE]",
      INSTANTLY_API_KEY: "never-copy-this",
    });

    expect(environment.APIFY_DAILY_COST_LIMIT_USD).toBe("5");
    expect(environment.ACTIVATION_MAX_DAILY_RAW_REQUESTS).toBe("1500");
    expect(environment.DATABASE_URL).toBe("local-placeholder");
    expect(environment.INSTANTLY_API_KEY).toBeUndefined();
  });

  it("prints only allowlisted diagnostic fields and never serializes secrets", () => {
    const diagnostic = {
      generatedAt: "2026-10-09T00:00:00.000Z",
      workspaceId: "workspace-secret-id",
      globalRawRequestCap: 1500,
      engines: [],
      importAttribution: {
        multiSourceImports: { today: 0, rolling3d: 1, rolling7d: 2 },
        unattributedImports: { today: 3, rolling3d: 4, rolling7d: 5 },
      },
      rolling: {
        rolling3dRequests: 100,
        rolling3dSameCohortYield: 0.02,
        rolling7dRequests: 200,
        rolling7dSameCohortYield: 0.03,
      },
      providerSpend: {
        actualProviderBilling: { status: "UNAVAILABLE", apiKey: "never-print-this" },
        configuredSpendGuards: {
          apifyDailyUsd: 5,
          apifyGlobalDailyUsd: 10,
          apifyWorkspaceDailyUsd: null,
          serperDailyUsd: 1,
          millionVerifierDailyUsd: 1,
        },
        spendEstimates: {
          apify: { todayUsd: 0.4, rolling7dUsd: 1 },
          serper: { todayUsd: 0.1, rolling7dUsd: 0.5 },
          millionVerifier: { todayUsd: 0.2, rolling7dUsd: 0.7 },
        },
      },
      instantly: {
        totalLeadCapacity: 1000,
        currentLeads: 100,
        remainingLeads: 900,
        monthlyEmailLimit: 5000,
        monthlyEmailsSent: 25,
      },
      requestsRequiredFor250: { p50: 1200, p75: 1500, p90: 2000, sampleCount: 7 },
      safeToRaiseCap: false,
      recommendedGlobalRawCap: null,
      apiToken: "never-print-this",
    } as unknown as Parameters<typeof formatCapacityReport>[0];
    const output = formatCapacityReport(diagnostic, new Map());

    expect(output).toContain("GLOBAL_RAW_REQUEST_CAP=1500");
    expect(output).toContain("MULTI_SOURCE_IMPORTS=TODAY:0,3D:1,7D:2");
    expect(output).not.toContain("never-print-this");
    expect(output).not.toContain("workspace-secret-id");
    expect(output).not.toContain("apiToken");
  });
});