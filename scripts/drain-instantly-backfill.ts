import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const TARGET_CAMPAIGN_ID = "055534c5-c3e3-414f-b140-f4770b293c00";

function parseArguments(args: readonly string[]) {
  const allowed = new Set(["--dry-run", "--execute", "--production"]);
  const unknown = args.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) throw new Error(`Unsupported argument: ${unknown[0]}`);
  if (args.includes("--dry-run") && args.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute.");
  }
  if (args.includes("--production") && !args.includes("--execute")) {
    throw new Error("--production is valid only with --execute.");
  }
  return { execute: args.includes("--execute"), productionConfirmed: args.includes("--production") };
}

function isRemoteDatabase(connectionString: string | undefined): boolean {
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }
  return !["localhost", "127.0.0.1", "::1"].includes(hostname) && !hostname.endsWith(".localhost");
}

function printPreview(preview: object): void {
  console.log("BACKFILL_PREVIEW");
  for (const [name, value] of Object.entries(preview)) console.log(`${name}=${value}`);
}

function remainingCount(progress: {
  verificationCandidatesRemaining: number;
  verificationJobsPending: number;
  verificationJobsProcessing: number;
  verificationProviderDisabledJobs: number;
  eligibleValidContactsRemaining: number;
  instantlyImportJobsPending: number;
}): number {
  return progress.verificationCandidatesRemaining
    + progress.verificationJobsPending
    + progress.verificationJobsProcessing
    + progress.verificationProviderDisabledJobs
    + progress.eligibleValidContactsRemaining
    + progress.instantlyImportJobsPending;
}

function safeErrorContext(error: unknown): string {
  if (error instanceof Error && error.message === "DATABASE_URL_INVALID") return error.message;
  if (error instanceof Error && "issues" in error && Array.isArray((error as Error & { issues: unknown[] }).issues)) {
    return (error as Error & { issues: Array<{ path?: PropertyKey[]; code?: string }> }).issues
      .map((issue) => `${issue.path?.join(".") || "configuration"}:${issue.code ?? "invalid"}`)
      .join(",");
  }
  if (error instanceof Error) {
    const frame = error.stack?.split("\n")[1]?.trim().replace(process.cwd(), ".");
    return frame ? `${error.name}@${frame}` : error.name;
  }
  return "UnknownError";
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const [runner, { drainHistoricalBackfill }, instantlyRunner, { getDatabaseEnv, getDeliveryEnv, getEmailComplianceEnv, getVerificationEnv }] = await Promise.all([
    import("@/infrastructure/jobs/runners/verification-runner"),
    import("@/infrastructure/jobs/runners/historical-backfill-drain"),
    import("@/infrastructure/jobs/runners/instantly-import-runner"),
    import("@/lib/config/env"),
  ]);
  const databaseEnv = getDatabaseEnv();
  const remoteDatabase = isRemoteDatabase(databaseEnv.DATABASE_URL ?? databaseEnv.DATABASE_URL_UNPOOLED);
  const deliveryEnv = getDeliveryEnv();
  const verificationEnv = getVerificationEnv();
  const emailPolicyEnv = getEmailComplianceEnv();

  if (options.execute && remoteDatabase && !options.productionConfirmed) {
    throw new Error("Writes to a remote database require the additional --production confirmation.");
  }

  console.log(`MODE=${options.execute ? "EXECUTE" : "DRY_RUN"}`);
  console.log(`DATABASE_CLASS=${remoteDatabase ? "REMOTE" : "LOCAL"}`);
  console.log(`TARGET_CAMPAIGN_MATCH=${deliveryEnv.INSTANTLY_CAMPAIGN_ID === TARGET_CAMPAIGN_ID ? "YES" : "NO"}`);
  console.log(`VERIFICATION_PROVIDER=${verificationEnv.EMAIL_VERIFICATION_PROVIDER}`);
  console.log(`DELIVERY_PROVIDER=${deliveryEnv.EMAIL_DELIVERY_PROVIDER}`);
  console.log(`EMAIL_POLICY_VERSION=v2.0.0`);
  console.log(`EMAIL_POLICY_APPROVED=${emailPolicyEnv.VITALCAP_B2B_EMAIL_POLICY_APPROVED ? "YES" : "NO"}`);
  console.log(`DEFAULT_DELIVERY_MODE=${process.env.DEFAULT_DELIVERY_MODE ?? "dry_run"}`);
  console.log(`AUTO_SEND=${process.env.AUTO_SEND?.toLowerCase() === "true" ? "ENABLED" : "DISABLED"}`);

  const preview = await runner.getHistoricalBackfillPreview();
  printPreview(preview);
  if (!options.execute) {
    console.log("NO_WRITES_PERFORMED=YES");
    return;
  }

  if (deliveryEnv.INSTANTLY_CAMPAIGN_ID !== TARGET_CAMPAIGN_ID) {
    throw new Error("Configured Instantly campaign does not match the required target campaign.");
  }
  if (verificationEnv.EMAIL_VERIFICATION_PROVIDER !== "millionverifier") {
    throw new Error("EMAIL_VERIFICATION_PROVIDER must be millionverifier before execute mode.");
  }
  if (deliveryEnv.EMAIL_DELIVERY_PROVIDER !== "instantly" || !deliveryEnv.INSTANTLY_API_KEY) {
    throw new Error("Instantly delivery is not fully configured; no drain work was started.");
  }
  if (process.env.AUTO_SEND?.toLowerCase() === "true") {
    throw new Error("AUTO_SEND must remain disabled during historical import.");
  }
  if ((process.env.DEFAULT_DELIVERY_MODE ?? "dry_run") !== "dry_run") {
    throw new Error("DEFAULT_DELIVERY_MODE must remain dry_run during the import drain.");
  }
  if (remoteDatabase && !emailPolicyEnv.VITALCAP_B2B_EMAIL_POLICY_APPROVED) {
    throw new Error("The versioned B2B email policy is not explicitly approved; production import is blocked.");
  }

  const result = await drainHistoricalBackfill({
    getProgress: runner.getHistoricalBackfillProgress,
    getPreview: runner.getHistoricalBackfillPreview,
    repairProviderDisabledJobs: runner.repairProviderDisabledVerificationJobs,
    enqueueVerificationJobs: () => runner.enqueueVerificationJobs(),
    runVerificationTick: runner.runVerificationCronTick,
    runInstantlyTick: instantlyRunner.runInstantlyImportTick,
  }, {
    onIteration: (pass) => {
      console.log(JSON.stringify({
        iteration: pass.iteration,
        verificationCandidatesRemaining: pass.progress.verificationCandidatesRemaining,
        verificationJobsPending: pass.progress.verificationJobsPending,
        verificationJobsProcessing: pass.progress.verificationJobsProcessing,
        providerDisabledRemaining: pass.progress.verificationProviderDisabledJobs,
        verifiedThisIteration: pass.verification.emailsVerified,
        cacheHits: pass.verification.cacheHits ?? 0,
        valid: pass.verification.verificationValid ?? 0,
        invalid: pass.verification.verificationInvalid ?? 0,
        risky: pass.verification.verificationRisky ?? 0,
        catchAll: pass.verification.verificationCatchAll ?? 0,
        channelClassificationsRepaired: 0,
        complianceAllowed: pass.preview.complianceAllowed,
        selectedContacts: pass.preview.selectedContacts,
        ready: pass.preview.readyMemberships,
        instantlyCandidates: pass.instantly.candidatesFound,
        instantlyQueued: pass.instantly.leadsQueued,
        instantlyAdded: pass.instantly.leadsAdded,
        instantlyExisting: pass.instantly.leadsExistingTarget ?? pass.instantly.leadsSkipped,
        instantlyNeedsCampaignMove: pass.instantly.leadsNeedsCampaignMove ?? 0,
        instantlyNeedsReconciliation: pass.instantly.leadsNeedsReconciliation ?? 0,
        instantlyFailed: pass.instantly.leadsFailed,
        instantlyDeferred: pass.instantly.leadsDeferred,
        remaining: remainingCount(pass.progress),
        consecutiveNoProgress: pass.consecutiveNoProgress,
      }));
    },
  });

  console.log(JSON.stringify({ outcome: result.outcome, reason: result.reason, progress: result.progress }, null, 2));
  if (result.outcome !== "complete") process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(`BACKFILL_STOPPED=${safeErrorContext(error)}; no secret or provider response details were printed.`);
  process.exitCode = 1;
});