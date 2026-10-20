export interface ProductionPipelineCounts {
  rawCandidates: number;
  processedRawCandidates: number;
  accountsLinked: number;
  websitePresent: number;
  websiteAccountsWithEmail: number;
  accountsWithEmail: number;
  verificationValid: number;
  eligible: number;
  instantlyImported: number;
}

export type ProductionPrimaryLossStage =
  | "NO_WEBSITE"
  | "WEBSITE_FETCH_FAILURE"
  | "NO_EMAIL_ON_SITE"
  | "EMAIL_REJECTED"
  | "VERIFICATION_LOSS"
  | "ICP_FILTER_LOSS"
  | "OTHER";

export type RecoveryPrimaryLossStage =
  | "NO_WEBSITE_ORIGINAL"
  | "RECOVERY_NOT_ATTEMPTED"
  | "RECOVERY_FAILED"
  | "RECOVERED_FETCH_FAILED"
  | "RECOVERED_FETCH_SUCCEEDED_NO_EMAIL"
  | "RECOVERED_EMAIL_INVALID"
  | "RECOVERED_VALID_NOT_ELIGIBLE"
  | "RECOVERED_ELIGIBLE_NOT_IMPORTED"
  | "UNCLASSIFIED_DUE_TO_MISSING_TELEMETRY";

export interface RecoveryAttributionCounts {
  recoveryTelemetryCoveragePct: number | null;
  recoveredFetchAttributionCoveragePct: number | null;
  recoveredEmailAttributionCoveragePct: number | null;
  recoveryAttempted: number;
  recoverySucceeded: number;
  recoveredFetchAttempted: number;
  recoveredFetchSucceeded: number;
  recoveredEmailFound: number;
  recoveredValidEmail: number;
  recoveredEligible: number;
  recoveredImported: number;
  minimumCoveragePct?: number;
}

function recoveryRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function calculateRecoveryAttributionRates(input: RecoveryAttributionCounts) {
  const minimumCoveragePct = input.minimumCoveragePct ?? 95;
  const coverageSufficient = input.recoveryTelemetryCoveragePct !== null
    && input.recoveryTelemetryCoveragePct >= minimumCoveragePct
    && input.recoveredFetchAttributionCoveragePct !== null
    && input.recoveredFetchAttributionCoveragePct >= minimumCoveragePct
    && input.recoveredEmailAttributionCoveragePct !== null
    && input.recoveredEmailAttributionCoveragePct >= minimumCoveragePct;
  const calculate = (numerator: number, denominator: number) =>
    coverageSufficient ? recoveryRate(numerator, denominator) : null;

  return {
    recoverySuccessRate: calculate(input.recoverySucceeded, input.recoveryAttempted),
    recoveredFetchSuccessRate: calculate(input.recoveredFetchSucceeded, input.recoveredFetchAttempted),
    recoveredFetchToEmailRate: calculate(input.recoveredEmailFound, input.recoveredFetchSucceeded),
    recoveredFetchToValidRate: calculate(input.recoveredValidEmail, input.recoveredFetchSucceeded),
    recoveredValidToEligibleRate: calculate(input.recoveredEligible, input.recoveredValidEmail),
    recoveredEligibleToImportRate: calculate(input.recoveredImported, input.recoveredEligible),
  };
}

export function classifyRecoveryPrimaryLossStage(input: {
  totalRows: number;
  recoveryTelemetryCoveragePct: number | null;
  recoveredFetchAttributionCoveragePct: number | null;
  recoveredEmailAttributionCoveragePct: number | null;
  minimumCoveragePct?: number;
  noWebsiteOriginal: number;
  recoveryNotAttempted: number;
  recoveryFailed: number;
  recoveredFetchFailed: number;
  recoveredFetchSucceededNoEmail: number;
  recoveredEmailInvalid: number;
  recoveredValidNotEligible: number;
  recoveredEligibleNotImported: number;
}): RecoveryPrimaryLossStage | null {
  const minimumCoveragePct = input.minimumCoveragePct ?? 95;
  if (input.totalRows === 0 || input.recoveryTelemetryCoveragePct === null
    || input.recoveryTelemetryCoveragePct < minimumCoveragePct
    || input.recoveredFetchAttributionCoveragePct === null
    || input.recoveredFetchAttributionCoveragePct < minimumCoveragePct
    || input.recoveredEmailAttributionCoveragePct === null
    || input.recoveredEmailAttributionCoveragePct < minimumCoveragePct) {
    return "UNCLASSIFIED_DUE_TO_MISSING_TELEMETRY";
  }

  const losses: Array<{ stage: RecoveryPrimaryLossStage; count: number }> = [
    { stage: "NO_WEBSITE_ORIGINAL", count: input.noWebsiteOriginal },
    { stage: "RECOVERY_NOT_ATTEMPTED", count: input.recoveryNotAttempted },
    { stage: "RECOVERY_FAILED", count: input.recoveryFailed },
    { stage: "RECOVERED_FETCH_FAILED", count: input.recoveredFetchFailed },
    { stage: "RECOVERED_FETCH_SUCCEEDED_NO_EMAIL", count: input.recoveredFetchSucceededNoEmail },
    { stage: "RECOVERED_EMAIL_INVALID", count: input.recoveredEmailInvalid },
    { stage: "RECOVERED_VALID_NOT_ELIGIBLE", count: input.recoveredValidNotEligible },
    { stage: "RECOVERED_ELIGIBLE_NOT_IMPORTED", count: input.recoveredEligibleNotImported },
  ];
  const largest = losses.reduce((current, loss) => loss.count > current.count ? loss : current);
  return largest.count > 0 ? largest.stage : null;
}

export function classifyProductionPrimaryLossStage(input: {
  rawCandidates: number;
  accountsLinked: number;
  websiteMissing: number;
  websiteFetchFailed: number;
  websiteFetchSucceeded: number;
  websiteAccountsWithEmail: number;
  emailRejectedFormat: number | null;
  emailDuplicate: number | null;
  accountsWithEmail: number;
  verificationValid: number;
  icpRejected: number;
  eligible: number;
  instantlyImported: number;
}): ProductionPrimaryLossStage {
  const losses: Array<{ stage: ProductionPrimaryLossStage; count: number }> = [
    { stage: "NO_WEBSITE", count: input.websiteMissing },
    { stage: "WEBSITE_FETCH_FAILURE", count: input.websiteFetchFailed },
    { stage: "NO_EMAIL_ON_SITE", count: Math.max(0, input.websiteFetchSucceeded - input.websiteAccountsWithEmail) },
    { stage: "EMAIL_REJECTED", count: (input.emailRejectedFormat ?? 0) + (input.emailDuplicate ?? 0) },
    { stage: "VERIFICATION_LOSS", count: Math.max(0, input.accountsWithEmail - input.verificationValid) },
    { stage: "ICP_FILTER_LOSS", count: input.icpRejected },
    {
      stage: "OTHER",
      count: Math.max(0, input.rawCandidates - input.accountsLinked)
        + Math.max(0, input.verificationValid - input.eligible)
        + Math.max(0, input.eligible - input.instantlyImported),
    },
  ];
  if (losses.every((loss) => loss.count <= 0)) return "OTHER";
  return losses.reduce((largest, loss) => loss.count > largest.count ? loss : largest).stage;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function calculateProductionPipelineRates(counts: ProductionPipelineCounts) {
  return {
    rawToAccount: ratio(counts.accountsLinked, counts.rawCandidates),
    accountToWebsite: ratio(counts.websitePresent, counts.accountsLinked),
    websiteToEmail: ratio(counts.websiteAccountsWithEmail, counts.websitePresent),
    rawToEmail: ratio(counts.accountsWithEmail, counts.processedRawCandidates),
    emailToValid: ratio(counts.verificationValid, counts.accountsWithEmail),
    validToEligible: ratio(counts.eligible, counts.verificationValid),
    eligibleToImport: ratio(counts.instantlyImported, counts.eligible),
  };
}