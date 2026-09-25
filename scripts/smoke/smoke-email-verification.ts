/**
 * Operator-only smoke test for the real MillionVerifier provider (Prompt 7
 * §28). Verifies a couple of known-shape test addresses and prints the
 * result — never wired into `npm test`/CI. Requires MILLIONVERIFIER_API_KEY
 * (the demo key "API_KEY_FOR_TEST" also works and returns a random result,
 * per MillionVerifier's own docs).
 *
 * Usage:
 *   MILLIONVERIFIER_API_KEY=xxx npm run smoke:email-verification
 */
import { MillionVerifierEmailVerificationProvider } from "../../src/infrastructure/providers/email-verification/millionverifier-provider";

async function main(): Promise<void> {
  const apiKey = process.env.MILLIONVERIFIER_API_KEY;
  if (!apiKey) {
    console.error("MILLIONVERIFIER_API_KEY is required.");
    process.exit(1);
  }

  const provider = new MillionVerifierEmailVerificationProvider({ apiKey });

  console.log("Running one real MillionVerifier batch...");
  const { outcomes, usage } = await provider.verifyBatch(["test@example.com", "not-a-real-address@nonexistent-domain-xyz123.com"]);

  console.log(`Verified ${outcomes.length} email(s), cost=$${usage.costUsd.toFixed(4)}, errors=${usage.errors}`);
  console.log(JSON.stringify(outcomes, null, 2));
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
