export interface InstantlyContactQuotaDecision {
  allowed: boolean;
  hardLimit: number;
  remaining: number;
  warning: boolean;
}

export function evaluateInstantlyContactQuota(input: {
  uploadedContacts: number;
  providerLimit: number;
  configuredHardLimit: number;
  warningThreshold: number;
}): InstantlyContactQuotaDecision {
  const hardLimit = Math.min(input.providerLimit, input.configuredHardLimit);
  const remaining = Math.max(0, hardLimit - input.uploadedContacts);
  return {
    allowed: remaining > 0,
    hardLimit,
    remaining,
    warning: input.uploadedContacts >= input.warningThreshold,
  };
}