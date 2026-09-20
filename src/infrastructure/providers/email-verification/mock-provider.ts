import type { EmailVerificationCode, EmailVerificationOutcome, EmailVerificationProvider } from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

/**
 * Development mock for `EmailVerificationProvider` (Prompt 2 §2.7). Assigns
 * a deterministic, distribution-shaped verification code per email so
 * engines/tests can exercise every acceptance branch (valid/catch_all/risky/
 * invalid) without a real verification API key.
 */
export class MockEmailVerificationProvider implements EmailVerificationProvider {
  readonly providerName = "mock-email-verification";

  async verifyBatch(emails: readonly string[]): ReturnType<EmailVerificationProvider["verifyBatch"]> {
    const checkedAt = new Date().toISOString();
    const outcomes: EmailVerificationOutcome[] = emails.map((email) => {
      const roll = seededRandom(hashString(email))();
      const code: EmailVerificationCode = roll > 0.85 ? "invalid" : roll > 0.7 ? "risky" : roll > 0.55 ? "catch_all" : "valid";
      return {
        email,
        code,
        providerRawCode: code.toUpperCase(),
        costUsd: 0.005,
        checkedAt,
      };
    });

    return {
      outcomes,
      usage: { calls: 1, items: emails.length, errors: 0, totalLatencyMs: 60, costUsd: emails.length * 0.005, quotaRemaining: null },
    };
  }
}
