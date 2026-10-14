import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { getCoreEnv, getMapsEnv, getSerperEnv, getVerificationEnv } from "@/lib/config/env";
import { resolveNeonVar } from "@/lib/config/env-utils";
import { getDayBounds } from "@/lib/time/day-bounds";
import { getProductionCapacityDiagnostics } from "@/infrastructure/neon/repositories/production-capacity-diagnostics";
import * as schema from "@/infrastructure/neon/schema";
import { estimateRequestsRequiredForTarget, type CapacityWindow } from "@/services/admin/production-capacity-metrics";
import { assertNeonDatabaseIdentity } from "./neon-database-identity";

type DiagnosticData = Awaited<ReturnType<typeof getProductionCapacityDiagnostics>>;
type RawNeonClient = NeonQueryFunction<false, false>;

type CostSampleRow = {
  provider: string;
  samples_today: number;
  samples_7d: number;
};

type CostSampleCounts = Map<string, { today: number; sevenDays: number }>;

const productionConfigKeys = [
  "ACTIVATION_MAX_DAILY_RAW_REQUESTS",
  "APIFY_DAILY_COST_LIMIT_USD",
  "APIFY_BATCH_COST_LIMIT_USD",
  "MAPS_PROVIDER",
  "SERPER_DAILY_COST_LIMIT_USD",
  "SERP_PROVIDER",
  "EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD",
  "EMAIL_VERIFICATION_PROVIDER",
  "EMAIL_DELIVERY_PROVIDER",
  "INSTANTLY_CAMPAIGN_ID",
  "INSTANTLY_MAX_UPLOADED_CONTACTS",
  "INSTANTLY_MAX_MONTHLY_EMAILS",
  "DEFAULT_DELIVERY_MODE",
] as const;

const privateCredentialPattern = /^(?:DATABASE_URL(?:_UNPOOLED)?|Vitalcap_DATABASE_URL(?:_UNPOOLED)?|INSTANTLY_API_KEY|APIFY_API_TOKEN|SERPER_API_KEY|MILLIONVERIFIER_API_KEY|EMAIL_VERIFICATION_PROVIDER_API_KEY)$/;

let failureStage = "environment-load";
let expectedProductionNeonHost: string | undefined;

export function readOnlyTransactionOptions<T extends { arrayMode?: boolean; fullResults?: boolean }>(options: T = {} as T) {
  return { ...options, readOnly: true as const };
}

export function assertReadOnlyTransaction(value: unknown): void {
  if (value !== "on") throw new Error("READ_ONLY_TRANSACTION_NOT_ENFORCED");
}

function restoreProcessEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (environment[name] === undefined) delete process.env[name];
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function parseEnvironmentDirectory(directory: string): Record<string, string | undefined> {
  const originalEnvironment = { ...process.env };
  try {
    return nextEnv.loadEnvConfig(directory, false, undefined, true).parsedEnv ?? {};
  } finally {
    restoreProcessEnvironment(originalEnvironment);
  }
}

function loadPrivateEnvironmentFile(fileName: string): Record<string, string | undefined> {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) return {};

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "vitalcap-capacity-env-"));
  try {
    copyFileSync(filePath, join(temporaryDirectory, ".env.local"));
    return parseEnvironmentDirectory(temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function pullProductionEnvironment(): Record<string, string | undefined> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "vitalcap-capacity-vercel-"));
  const environmentFile = join(temporaryDirectory, ".env.production.local");
  try {
    const result = spawnSync("npx", [
      "vercel", "env", "pull", environmentFile,
      "--environment", "production",
      "--project", "vitalcapproject",
      "--scope", "tommynabos-projects",
      "--yes",
    ], { cwd: process.cwd(), stdio: "ignore" });
    if (result.error || result.status !== 0 || !existsSync(environmentFile)) {
      throw new Error("PRODUCTION_CONFIGURATION_UNAVAILABLE");
    }
    return parseEnvironmentDirectory(temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function applyProductionConfiguration(
  environment: Record<string, string | undefined>,
  inheritedEnvironment: Record<string, string | undefined>,
  productionEnvironment: Record<string, string | undefined>,
): void {
  for (const name of productionConfigKeys) {
    const value = productionEnvironment[name];
    if (inheritedEnvironment[name] === undefined && value !== undefined && value !== "[SENSITIVE]") {
      environment[name] = value;
    }
  }
}

function loadReportEnvironment(): void {
  const inheritedEnvironment = { ...process.env };
  const productionEnvironment = pullProductionEnvironment();
  expectedProductionNeonHost = productionEnvironment.Vitalcap_PGHOST;
  const privateEnvironment = {
    ...loadPrivateEnvironmentFile(".env.database"),
    ...loadPrivateEnvironmentFile(".env.database.credentials"),
    ...loadPrivateEnvironmentFile(".env.instantly.credentials"),
  };

  nextEnv.loadEnvConfig(process.cwd(), false, undefined, true);
  applyProductionConfiguration(process.env, inheritedEnvironment, productionEnvironment);
  for (const [name, value] of Object.entries(privateEnvironment)) {
    if (privateCredentialPattern.test(name) && inheritedEnvironment[name] === undefined && value !== undefined) {
      process.env[name] = value;
    }
  }
  if (!(["dry_run", "live"] as const).includes(process.env.DEFAULT_DELIVERY_MODE as "dry_run" | "live")) {
    process.env.DEFAULT_DELIVERY_MODE = "dry_run";
  }
}

function resolveProductionDatabaseUrl(): string {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.Vitalcap_DATABASE_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.Vitalcap_DATABASE_URL_UNPOOLED,
    resolveNeonVar("DATABASE_URL"),
    resolveNeonVar("DATABASE_URL_UNPOOLED"),
  ];
  const databaseUrl = candidates.find((value) => value && !value.includes("[SENSITIVE]"));
  if (!databaseUrl) throw new Error("PRODUCTION_DATABASE_CREDENTIALS_UNAVAILABLE");

  assertNeonDatabaseIdentity(databaseUrl, expectedProductionNeonHost);
  return databaseUrl;
}

function createReadOnlyNeonClient(databaseUrl: string) {
  const rawClient = neon(databaseUrl);
  const executeTransaction = rawClient.transaction as unknown as (
    queries: unknown[],
    options: { arrayMode?: boolean; fullResults?: boolean; readOnly: true },
  ) => Promise<unknown[]>;
  const client = new Proxy(rawClient, {
    get(target, property, receiver) {
      if (property === "query") {
        return (statement: string, params: unknown[] = [], options: { arrayMode?: boolean; fullResults?: boolean } = {}) => {
          const query = target.query(statement, params, options);
          return executeTransaction([query], readOnlyTransactionOptions(options)).then(([result]) => result);
        };
      }
      if (property === "transaction") {
        return () => {
          throw new Error("READ_ONLY_CLIENT_REQUIRES_GUARDED_QUERY");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as typeof rawClient;

  return { rawClient, client };
}

async function verifyReadOnlyConnection(rawClient: RawNeonClient): Promise<void> {
  const [rows] = await rawClient.transaction<false, false>(
    [rawClient`SELECT current_setting('transaction_read_only') AS read_only`],
    { readOnly: true, arrayMode: false, fullResults: false },
  );
  assertReadOnlyTransaction(rows?.[0]?.read_only);
}

async function getCostSampleCounts(
  rawClient: RawNeonClient,
  workspaceId: string,
  timezone: string,
  now: Date,
): Promise<CostSampleCounts> {
  const todayStart = getDayBounds(timezone, now).start;
  const sevenDayStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [rows] = await rawClient.transaction<false, false>(
    [rawClient`
      SELECT provider,
        COUNT(cost_usd) FILTER (WHERE started_at >= ${todayStart.toISOString()}::timestamptz AND started_at < ${now.toISOString()}::timestamptz)::int AS samples_today,
        COUNT(cost_usd) FILTER (WHERE started_at >= ${sevenDayStart.toISOString()}::timestamptz AND started_at < ${now.toISOString()}::timestamptz)::int AS samples_7d
      FROM provider_runs
      WHERE workspace_id = ${workspaceId}::uuid
        AND provider IN ('apify', 'serper', 'email_verification')
        AND started_at >= ${sevenDayStart.toISOString()}::timestamptz
        AND started_at < ${now.toISOString()}::timestamptz
      GROUP BY provider
    `],
    { readOnly: true, arrayMode: false, fullResults: false },
  );

  return new Map((rows as CostSampleRow[]).map((row) => [row.provider, {
    today: Number(row.samples_today ?? 0),
    sevenDays: Number(row.samples_7d ?? 0),
  }]));
}

function printableNumber(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "UNKNOWN" : Number(value.toFixed(digits)).toString();
}

function percentileConfidence(sampleDays: number): "HIGH" | "MEDIUM" | "LOW" {
  if (sampleDays >= 14) return "HIGH";
  if (sampleDays >= 7) return "MEDIUM";
  return "LOW";
}

function scenarioLine(
  cap: number,
  diagnostics: DiagnosticData,
  costSamples: CostSampleCounts,
): string {
  const requests = diagnostics.rolling.rolling7dRequests;
  const yieldPerRequest = diagnostics.rolling.rolling7dSameCohortYield;
  const estimates = diagnostics.providerSpend.spendEstimates;
  const completeCostData = ["apify", "serper", "email_verification"]
    .every((provider) => (costSamples.get(provider)?.sevenDays ?? 0) > 0);
  const totalSpend = estimates.apify.rolling7dUsd + estimates.serper.rolling7dUsd + estimates.millionVerifier.rolling7dUsd;
  const expectedImports = yieldPerRequest === null ? null : cap * yieldPerRequest;
  const estimatedSpend = completeCostData && requests > 0 ? cap * totalSpend / requests : null;
  return `CAP_${cap}=expected_imports:${printableNumber(expectedImports)};estimated_spend_usd:${printableNumber(estimatedSpend)};spend_basis:rolling7d_cost_per_request`;
}

export function formatCapacityReport(
  diagnostics: DiagnosticData,
  costSamples: CostSampleCounts,
): string {
  const windows: readonly [CapacityWindow, string][] = [["today", "TODAY"], ["rolling3d", "3D"], ["rolling7d", "7D"]];
  const engines = diagnostics.engines.map((engine) => {
    const periods = windows.map(([window, label]) => {
      const period = engine.periods[window];
      return `${label}{REQUESTS=${period.requests};SOURCE_ROWS=${period.sourceRows};UNIQUE_ACCOUNTS=${period.uniqueAccounts};WITH_EMAIL=${period.withEmail};MV_VALID=${period.mvValid};ELIGIBLE=${period.eligible};SAME_COHORT_CONFIRMED_IMPORTS=${period.sameCohortConfirmedImports};BACKLOG_CONFIRMED_IMPORTS=${period.backlogConfirmedImports}}`;
    });
    return `${engine.engine} ${periods.join(" ")}`;
  }).join(" | ");
  const attribution = diagnostics.importAttribution;
  const guards = diagnostics.providerSpend.configuredSpendGuards;
  const estimates = diagnostics.providerSpend.spendEstimates;
  const samples = diagnostics.requestsRequiredFor250.sampleCount;
  const confidence = percentileConfidence(samples);
  const required = diagnostics.requestsRequiredFor250;
  const actualBillingAvailable = String(diagnostics.providerSpend.actualProviderBilling.status) === "ACTUAL";
  const capSafe = actualBillingAvailable && diagnostics.safeToRaiseCap;
  const blocker = samples < 3
    ? "INSUFFICIENT_HISTORY"
    : !actualBillingAvailable
      ? "COST_DATA_MISSING"
      : !diagnostics.safeToRaiseCap
        ? "PROVIDER_CAP"
        : "NONE";
  const nextStep = blocker === "INSUFFICIENT_HISTORY"
    ? "IMPROVE_EMAIL_COVERAGE"
    : blocker === "COST_DATA_MISSING"
      ? "AUDIT_REAL_PROVIDER_BILLING"
      : capSafe
        ? "RAISE_CAP_TO_RECOMMENDED_LEVEL"
        : "FIX_CAPACITY_REPORT";
  const lines = [
    "READ_ONLY_PRODUCTION_REPORT=PASS",
    `GLOBAL_RAW_REQUEST_CAP=${diagnostics.globalRawRequestCap}`,
    `ENGINE_METRICS=${engines || "NONE"}`,
    `MULTI_SOURCE_IMPORTS=TODAY:${attribution.multiSourceImports.today},3D:${attribution.multiSourceImports.rolling3d},7D:${attribution.multiSourceImports.rolling7d}`,
    `UNATTRIBUTED_IMPORTS_TODAY=${attribution.unattributedImports.today}`,
    `UNATTRIBUTED_IMPORTS_3D=${attribution.unattributedImports.rolling3d}`,
    `UNATTRIBUTED_IMPORTS_7D=${attribution.unattributedImports.rolling7d}`,
    `ROLLING_3D_SAME_COHORT_YIELD=${printableNumber(diagnostics.rolling.rolling3dSameCohortYield)}`,
    `ROLLING_7D_SAME_COHORT_YIELD=${printableNumber(diagnostics.rolling.rolling7dSameCohortYield)}`,
    `SAMPLE_DAYS=${samples}`,
    `PERCENTILE_CONFIDENCE=${confidence}`,
    `REQUESTS_REQUIRED_P50=${printableNumber(required.p50, 0)}`,
    `REQUESTS_REQUIRED_P75=${printableNumber(required.p75, 0)}`,
    `REQUESTS_REQUIRED_P90=${printableNumber(required.p90, 0)}`,
    `APIFY_DAILY_BUDGET=${guards.apifyDailyUsd}`,
    `APIFY_ESTIMATED_SPEND_TODAY=${(costSamples.get("apify")?.today ?? 0) > 0 ? printableNumber(estimates.apify.todayUsd) : "UNKNOWN"}`,
    "APIFY_ACTUAL_SPEND_TODAY=UNKNOWN",
    `SERPER_DAILY_BUDGET=${guards.serperDailyUsd}`,
    `SERPER_ESTIMATED_SPEND_TODAY=${(costSamples.get("serper")?.today ?? 0) > 0 ? printableNumber(estimates.serper.todayUsd) : "UNKNOWN"}`,
    "SERPER_ACTUAL_SPEND_TODAY=UNKNOWN",
    `MV_DAILY_BUDGET=${guards.millionVerifierDailyUsd}`,
    `MV_ESTIMATED_SPEND_TODAY=${(costSamples.get("email_verification")?.today ?? 0) > 0 ? printableNumber(estimates.millionVerifier.todayUsd) : "UNKNOWN"}`,
    "MV_ACTUAL_SPEND_TODAY=UNKNOWN",
    `INSTANTLY_TOTAL_LEAD_CAPACITY=${diagnostics.instantly.totalLeadCapacity ?? "UNKNOWN"}`,
    `INSTANTLY_CURRENT_LEADS=${diagnostics.instantly.currentLeads ?? "UNKNOWN"}`,
    `INSTANTLY_REMAINING_LEADS=${diagnostics.instantly.remainingLeads ?? "UNKNOWN"}`,
    `INSTANTLY_MONTHLY_EMAIL_LIMIT=${diagnostics.instantly.monthlyEmailLimit}`,
    `INSTANTLY_EMAILS_SENT_THIS_MONTH=${diagnostics.instantly.monthlyEmailsSent ?? "UNKNOWN"}`,
    scenarioLine(1500, diagnostics, costSamples),
    scenarioLine(2000, diagnostics, costSamples),
    scenarioLine(2500, diagnostics, costSamples),
    scenarioLine(3000, diagnostics, costSamples),
    `SAFE_TO_USE_REPORT_FOR_CAP_DECISION=${capSafe ? "YES" : "NO"}`,
    `RECOMMENDED_GLOBAL_RAW_CAP=${capSafe ? diagnostics.recommendedGlobalRawCap ?? "UNKNOWN" : "UNKNOWN"}`,
    `SAFE_TO_RAISE_CAP=${capSafe ? "YES" : "NO"}`,
    `BLOCKER=${blocker}`,
    `NEXT_STEP=${nextStep}`,
  ];
  return lines.join("\n");
}

async function runReport(): Promise<void> {
  loadReportEnvironment();
  failureStage = "database-connection";
  const databaseUrl = resolveProductionDatabaseUrl();
  const { rawClient, client } = createReadOnlyNeonClient(databaseUrl);
  await verifyReadOnlyConnection(rawClient);

  failureStage = "workspace-selection";
  const database = drizzle({ client, schema });
  const configuredWorkspaceId = process.env.CAPACITY_REPORT_WORKSPACE_ID?.trim();
  const workspaces = await database.select({ id: schema.workspaces.id }).from(schema.workspaces);
  const workspaceId = configuredWorkspaceId ?? (workspaces.length === 1 ? workspaces[0]!.id : undefined);
  if (!workspaceId || (configuredWorkspaceId && !workspaces.some((workspace) => workspace.id === configuredWorkspaceId))) {
    throw new Error("CAPACITY_REPORT_WORKSPACE_SELECTION_REQUIRED");
  }

  failureStage = "diagnostics-query";
  const now = new Date();
  const diagnostics = await getProductionCapacityDiagnostics(workspaceId, now, database);
  failureStage = "cost-sample-query";
  const costSamples = await getCostSampleCounts(rawClient, workspaceId, diagnostics.timezone, now);
  failureStage = "report-formatting";
  console.log(formatCapacityReport(diagnostics, costSamples));
}

export async function main(): Promise<void> {
  try {
    await runReport();
  } catch (error) {
    const issues = (error as { issues?: unknown[] } | null)?.issues;
    const code = issues?.length
      ? "APP_CONFIG_VALIDATION_FAILED"
      : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "CAPACITY_REPORT_FAILED";
    console.log(`READ_ONLY_PRODUCTION_REPORT=FAIL\nBLOCKER=${code}\nFAILURE_STAGE=${failureStage}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}