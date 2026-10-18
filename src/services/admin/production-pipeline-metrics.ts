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