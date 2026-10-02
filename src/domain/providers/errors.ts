export class ProviderBudgetExceededError extends Error {
  constructor(message: string, readonly retryAt: Date) {
    super(message);
    this.name = "ProviderBudgetExceededError";
  }
}