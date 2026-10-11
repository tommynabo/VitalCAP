export type ProviderFailureKind = "transient" | "billing" | "authentication" | "configuration" | "safety";

export const PROVIDER_RETRY_DELAYS_MS = {
  transient: 2 * 60 * 1000,
  billing: 30 * 60 * 1000,
  authentication: 6 * 60 * 60 * 1000,
  safety: 60 * 60 * 1000,
} as const;

export function getProviderFailureRetryAt(error: ProviderFailureError, now = new Date()): Date | null {
  if (!error.retryAt) return null;
  const windowMs = 15 * 60 * 1000;
  const nextRequestWindow = new Date((Math.floor(now.getTime() / windowMs) + 1) * windowMs);
  return error.retryAt > nextRequestWindow ? error.retryAt : nextRequestWindow;
}

export class ProviderFailureError extends Error {
  constructor(message: string, readonly kind: ProviderFailureKind, readonly retryAt: Date | null) {
    super(message);
    this.name = "ProviderFailureError";
  }
}

export class ProviderTransientError extends ProviderFailureError {
  constructor(message: string, now = new Date()) {
    super(message, "transient", new Date(now.getTime() + PROVIDER_RETRY_DELAYS_MS.transient));
    this.name = "ProviderTransientError";
  }
}

export class ProviderBillingError extends ProviderFailureError {
  constructor(message: string, now = new Date()) {
    super(message, "billing", new Date(now.getTime() + PROVIDER_RETRY_DELAYS_MS.billing));
    this.name = "ProviderBillingError";
  }
}

export class ProviderAuthenticationError extends ProviderFailureError {
  constructor(message: string, now = new Date()) {
    super(message, "authentication", new Date(now.getTime() + PROVIDER_RETRY_DELAYS_MS.authentication));
    this.name = "ProviderAuthenticationError";
  }
}

export class ProviderConfigurationError extends ProviderFailureError {
  constructor(message: string) {
    super(message, "configuration", null);
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderSafetyError extends ProviderFailureError {
  constructor(message: string, now = new Date()) {
    super(message, "safety", new Date(now.getTime() + PROVIDER_RETRY_DELAYS_MS.safety));
    this.name = "ProviderSafetyError";
  }
}

export class ProviderBudgetExceededError extends Error {
  constructor(message: string, readonly retryAt: Date, readonly budgetKind: "daily_budget" | "raw_request_cap" = "daily_budget") {
    super(message);
    this.name = "ProviderBudgetExceededError";
  }
}