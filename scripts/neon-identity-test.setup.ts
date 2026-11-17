import { initializeNeonIdentityTestResource } from "./neon-identity-test-resource";

const ready = await initializeNeonIdentityTestResource();
process.env.VITALCAP_NEON_IDENTITY_TEST_READY = ready ? "true" : "false";

if (!ready) {
  console.info("NEON_HTTP_IDENTITY_TEST=SKIPPED; set the explicit test-only Neon resource variables to run it. No default database was considered.");
}