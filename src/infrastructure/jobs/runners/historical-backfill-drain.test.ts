import { describe, expect, it } from "vitest";
import type { HistoricalBackfillPreview, HistoricalBackfillProgress } from "./verification-runner";
import type { HistoricalBackfillDrainDependencies } from "./historical-backfill-drain";
import { drainHistoricalBackfill } from "./historical-backfill-drain";

function emptyProgress(overrides: Partial<HistoricalBackfillProgress> = {}): HistoricalBackfillProgress {
  return {
    verificationCandidatesRemaining: 0,
    verificationJobsPending: 0,
    verificationJobsProcessing: 0,
    verificationProviderDisabledJobs: 0,
    eligibleValidContactsRemaining: 0,
    instantlyImportJobsPending: 0,
    instantlyDeferredDueToPlanLimit: 0,
    ...overrides,
  };
}

const emptyPreview: HistoricalBackfillPreview = {
  historicalAccounts: 0,
  accountsWithEmail: 0,
  channelUnknown: 0,
  channelEligible: 0,
  channelBlocked: 0,
  unverified: 0,
  verificationValid: 0,
  verificationInvalid: 0,
  verificationRisky: 0,
  verificationCatchAll: 0,
  providerDisabledJobs: 0,
  verificationJobsPending: 0,
  verificationJobsProcessing: 0,
  complianceMissing: 0,
  complianceAllowed: 0,
  complianceReviewRequired: 0,
  complianceBlocked: 0,
  selectedContacts: 0,
  readyMemberships: 0,
  eligibleInstantly: 0,
  alreadyImportedTarget: 0,
  needsCampaignMove: 0,
  failedImports: 0,
  reconciliationRequired: 0,
  instantlyDeferredDueToPlanLimit: 0,
  deferred: 0,
  planCapacity: 1000,
};

function emptyDependencies(state: HistoricalBackfillProgress): HistoricalBackfillDrainDependencies {
  return {
    getProgress: async () => ({ ...state }),
    getPreview: async () => emptyPreview,
    repairProviderDisabledJobs: async () => ({ inspected: 0, resolvedFromCurrentResult: 0, reactivated: 0, suppressed: 0 }),
    enqueueVerificationJobs: async () => 0,
    runVerificationTick: async () => ({ jobsClaimed: 0, emailsVerified: 0, millionVerifierStatus: "ready" }),
    runInstantlyTick: async () => ({
      candidatesFound: 0,
      leadsQueued: 0,
      leadsAdded: 0,
      leadsSkipped: 0,
      leadsDeferred: 0,
      leadsFailed: 0,
      providerStatus: "ready",
      instantlyLeadImportReady: true,
      instantlyTelemetryReady: true,
      telemetryWarnings: [],
      quota: null,
      metrics: {},
    }),
  };
}

describe("drainHistoricalBackfill", () => {
  it("drains 500 candidates across multiple bounded batches", async () => {
    const state = emptyProgress({ verificationCandidatesRemaining: 500 });
    const dependencies = emptyDependencies(state);
    dependencies.enqueueVerificationJobs = async () => {
      const queued = state.verificationCandidatesRemaining;
      state.verificationCandidatesRemaining = 0;
      state.verificationJobsPending += queued;
      return queued;
    };
    dependencies.runVerificationTick = async (batchSize) => {
      const verified = Math.min(batchSize, state.verificationJobsPending);
      state.verificationJobsPending -= verified;
      state.eligibleValidContactsRemaining += verified;
      return { jobsClaimed: verified, emailsVerified: verified, millionVerifierStatus: "ready" };
    };
    dependencies.runInstantlyTick = async () => {
      const added = Math.min(50, state.eligibleValidContactsRemaining);
      state.eligibleValidContactsRemaining -= added;
      return {
        candidatesFound: added,
        leadsQueued: added,
        leadsAdded: added,
        leadsSkipped: 0,
        leadsDeferred: 0,
        leadsFailed: 0,
        providerStatus: "ready",
        instantlyLeadImportReady: true,
        instantlyTelemetryReady: true,
        telemetryWarnings: [],
        quota: null,
        metrics: {},
      };
    };

    const result = await drainHistoricalBackfill(dependencies);

    expect(result.outcome).toBe("complete");
    expect(result.iterations.length).toBeGreaterThan(1);
    expect(result.iterations.reduce((total, pass) => total + pass.verification.emailsVerified, 0)).toBe(500);
  });

  it("stops after two consecutive passes without progress", async () => {
    const result = await drainHistoricalBackfill(emptyDependencies(emptyProgress({
      verificationCandidatesRemaining: 1,
    })));

    expect(result.outcome).toBe("blocked");
    expect(result.iterations).toHaveLength(2);
    expect(result.reason).toContain("No progress for two passes");
  });

  it("stops immediately when MillionVerifier is unavailable", async () => {
    const dependencies = emptyDependencies(emptyProgress({ verificationJobsPending: 1 }));
    dependencies.runVerificationTick = async () => ({
      jobsClaimed: 0,
      emailsVerified: 0,
      millionVerifierStatus: "missing_configuration",
    });

    const result = await drainHistoricalBackfill(dependencies);

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("MillionVerifier is missing_configuration");
  });

  it("reports plan capacity as a terminal blocker instead of retrying forever", async () => {
    const state = emptyProgress({ eligibleValidContactsRemaining: 1 });
    const dependencies = emptyDependencies(state);
    dependencies.runInstantlyTick = async () => {
      state.eligibleValidContactsRemaining = 0;
      state.instantlyDeferredDueToPlanLimit = 1;
      return {
        candidatesFound: 1,
        leadsQueued: 0,
        leadsAdded: 0,
        leadsSkipped: 0,
        leadsDeferred: 1,
        leadsFailed: 0,
        providerStatus: "ready",
        instantlyLeadImportReady: true,
        instantlyTelemetryReady: true,
        telemetryWarnings: [],
        quota: null,
        metrics: {},
      };
    };

    const result = await drainHistoricalBackfill(dependencies);

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("plan capacity is exhausted");
  });
});