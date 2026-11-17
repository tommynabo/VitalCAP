import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertVerifiedTestResourceAttestation } from "./neon-identity-test-resource";
import type { MapsPlaceResult } from "../src/domain/providers/types";
import type { AccountIdentitySignals } from "../src/services/deduplication/account-dedup";
import type { InsertAccountInput } from "../src/infrastructure/neon/repositories/accounts";

const integrationReady = process.env.VITALCAP_NEON_IDENTITY_TEST_READY === "true";
const verifiedEndpointHost = "ep-odd-firefly-b9x1w52c.c-7.eu-central-1.aws.neon.tech";

function connectionUrl(role: string, database: string, host = verifiedEndpointHost): string {
  return `postgresql://${role}@${host}/${database}?sslmode=require`;
}

const attestedResource = {
  databaseUrl: connectionUrl("vitalcap_identity_itest_rw", "vitalcap_identity_itest"),
  unpooledDatabaseUrl: connectionUrl("vitalcap_identity_itest_rw", "vitalcap_identity_itest"),
  migrationDatabaseUrl: connectionUrl("neondb_owner", "vitalcap_identity_itest"),
  projectId: "shiny-cake-82433983",
  branchId: "br-small-dew-b9aujn0g",
  endpointId: "ep-odd-firefly-b9x1w52c",
  databaseName: "vitalcap_identity_itest",
  roleName: "vitalcap_identity_itest_rw",
};
const reportResults = process.env.NEON_IDENTITY_TEST_REPORT_RESULTS === "true";

function reportScenarioResult(scenario: string, result: Record<string, unknown>): void {
  if (reportResults) console.info(`NEON_IDENTITY_SCENARIO=${JSON.stringify({ scenario, ...result })}`);
}

describe("verified Neon test resource attestation", () => {
  it("accepts the exact independently verified resource", () => {
    expect(() => assertVerifiedTestResourceAttestation(attestedResource)).not.toThrow();
  });

  it("keeps static attestation fixtures free of database passwords", () => {
    for (const connection of [attestedResource.databaseUrl, attestedResource.unpooledDatabaseUrl, attestedResource.migrationDatabaseUrl]) {
      expect(new URL(connection).password).toBe("");
    }
  });

  it("rejects a mismatched endpoint host", () => {
    expect(() => assertVerifiedTestResourceAttestation({
      ...attestedResource,
      databaseUrl: connectionUrl("vitalcap_identity_itest_rw", "vitalcap_identity_itest", "other-project.neon.tech"),
    })).toThrow("Runtime connection does not match");
  });

  it("rejects a mismatched database", () => {
    expect(() => assertVerifiedTestResourceAttestation({
      ...attestedResource,
      databaseUrl: connectionUrl("vitalcap_identity_itest_rw", "neondb"),
    })).toThrow("Runtime connection does not match");
  });

  it("rejects a mismatched runtime role", () => {
    expect(() => assertVerifiedTestResourceAttestation({
      ...attestedResource,
      databaseUrl: connectionUrl("neondb_owner", "vitalcap_identity_itest"),
    })).toThrow("Runtime connection does not match");
  });

  it("rejects a mismatched project identity", () => {
    expect(() => assertVerifiedTestResourceAttestation({
      ...attestedResource,
      projectId: "morning-dew-35696777",
    })).toThrow("Test resource metadata does not match");
  });
});

if (!integrationReady) {
  describe("Neon HTTP application integration", () => {
    it.skip("requires VITALCAP_NEON_IDENTITY_TEST_DATABASE_URL and verified test-project metadata; default DB URLs are never used", () => {});
  });
} else {
  const [{ getDb }, accountRepository, candidateProcessor, processingRunner] = await Promise.all([
    import("../src/infrastructure/neon/db"),
    import("../src/infrastructure/neon/repositories/accounts"),
    import("../src/services/discovery/candidate-processor"),
    import("../src/infrastructure/jobs/runners/processing-runner"),
  ]);
  const db = getDb();

  interface CampaignFixture {
    workspaceId: string;
    campaignId: string;
  }

  async function createCampaignFixture(): Promise<CampaignFixture> {
    const workspaceRows = await db.execute(sql`
      INSERT INTO workspaces (name)
      VALUES (${"neon-identity-itest-" + randomUUID()})
      RETURNING id
    `);
    const workspaceId = (workspaceRows.rows[0] as { id: string }).id;
    const offerRows = await db.execute(sql`
      INSERT INTO offers (workspace_id, name, company, primary_cta, booking_url, active)
      VALUES (${workspaceId}::uuid, 'Synthetic identity test', 'VitalCAP test fixture', 'Book', 'https://example.invalid/book', false)
      RETURNING id
    `);
    const offerId = (offerRows.rows[0] as { id: string }).id;
    const campaignRows = await db.execute(sql`
      INSERT INTO campaigns (workspace_id, offer_id, name, status, engine_type, engine_config, autopilot_enabled)
      VALUES (${workspaceId}::uuid, ${offerId}::uuid, 'Synthetic identity test', 'active', 'maps_fast', '{}'::jsonb, false)
      RETURNING id
    `);

    return { workspaceId, campaignId: (campaignRows.rows[0] as { id: string }).id };
  }

  function makePlace(overrides: Partial<MapsPlaceResult> & Pick<MapsPlaceResult, "externalPlaceId" | "name">): MapsPlaceResult {
    return {
      externalPlaceId: overrides.externalPlaceId,
      name: overrides.name,
      category: overrides.category ?? "Farmacia",
      address: overrides.address ?? "Calle de prueba 1",
      postalCode: overrides.postalCode ?? "02001",
      province: overrides.province ?? "Albacete",
      city: overrides.city ?? "Albacete",
      countryCode: overrides.countryCode ?? "ES",
      websiteUrl: overrides.websiteUrl ?? null,
      phone: overrides.phone ?? null,
      latitude: overrides.latitude ?? 38.9943,
      longitude: overrides.longitude ?? -1.8564,
      rating: overrides.rating ?? 4.5,
      reviewCount: overrides.reviewCount ?? 10,
      sourceUrl: overrides.sourceUrl ?? `https://maps.example.invalid/place/${overrides.externalPlaceId}`,
    };
  }

  async function enqueuePlace(campaignId: string, place: MapsPlaceResult, fingerprint: string): Promise<string> {
    const discoveryRows = await db.execute(sql`
      INSERT INTO discovery_jobs (campaign_id, type, payload, status)
      VALUES (${campaignId}::uuid, 'test_fixture', '{}'::jsonb, 'completed')
      RETURNING id
    `);
    const discoveryJobId = (discoveryRows.rows[0] as { id: string }).id;
    const rawRows = await db.execute(sql`
      INSERT INTO raw_candidates (
        discovery_job_id, campaign_id, engine_type, source_external_id, source_url,
        source_fingerprint, raw_payload
      ) VALUES (
        ${discoveryJobId}::uuid, ${campaignId}::uuid, 'maps_fast', ${place.externalPlaceId},
        ${place.sourceUrl}, ${fingerprint}, ${JSON.stringify({ kind: "maps", place })}::jsonb
      )
      RETURNING id
    `);
    const rawCandidateId = (rawRows.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO processing_jobs (campaign_id, type, payload, next_attempt_at)
      VALUES (
        ${campaignId}::uuid,
        'process_raw_candidate',
        ${JSON.stringify({ rawCandidateId })}::jsonb,
        now() - INTERVAL '1 minute'
      )
    `);
    return rawCandidateId;
  }

  async function processPlace(campaignId: string, rawCandidateId: string): Promise<void> {
    const result = await processingRunner.runProcessingCronTick(1, new Date(), {
      campaignId,
      rawCandidateIds: [rawCandidateId],
      enrichContacts: false,
      allowMapsFastWebsiteRecovery: false,
      allowNicheWebsiteClassificationEvidence: false,
      timeBudgetMs: 30_000,
      perJobBudgetMs: 20_000,
    });
    if (result.jobsClaimed !== 1) {
      const jobs = await db.execute(sql`
        SELECT status, attempt_count, max_attempts, locked_at, next_attempt_at, created_at
        FROM processing_jobs
        WHERE campaign_id = ${campaignId}::uuid
          AND payload->>'rawCandidateId' = ${rawCandidateId}
      `);
      throw new Error(`Expected one processing job claim; received ${JSON.stringify({ result, jobs: jobs.rows })}.`);
    }
    expect(result.jobsClaimed).toBe(1);
    expect(result.jobsCompleted).toBe(1);
    expect(result.cleanupFailures).toBe(0);
  }

  function identityFor(workspaceId: string, place: MapsPlaceResult): {
    incoming: Omit<AccountIdentitySignals, "accountId">;
    account: InsertAccountInput;
  } {
    const incoming = candidateProcessor.deriveIncomingIdentitySignals({ kind: "maps", place });
    return {
      incoming,
      account: {
        workspaceId,
        canonicalName: place.name,
        normalizedName: incoming.normalizedName,
        businessType: "pharmacy",
        countryCode: place.countryCode,
        region: null,
        province: place.province,
        city: place.city,
        postalCode: place.postalCode,
        addressLine: place.address,
        normalizedAddress: incoming.normalizedAddress ?? null,
        latitude: place.latitude,
        longitude: place.longitude,
        phone: place.phone,
        normalizedPhone: incoming.normalizedPhone ?? null,
        websiteUrl: place.websiteUrl,
        normalizedDomain: incoming.normalizedDomain ?? null,
        googlePlaceId: place.externalPlaceId,
        mapsUrl: place.sourceUrl,
        rating: place.rating,
        reviewCount: place.reviewCount,
        status: "discovered",
      },
    };
  }

  describe.sequential("Neon HTTP canonical identity application integration", () => {
    let fixture: CampaignFixture;

    beforeAll(async () => {
      fixture = await createCampaignFixture();
    });

    afterAll(async () => {
      if (fixture?.workspaceId) {
        await db.execute(sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}::uuid`);
      }
    });

    it("A: keeps unrelated Facebook businesses separate through the processing runner", async () => {
      const pharmacy = makePlace({
        externalPlaceId: "itest-facebook-farmacia-punal",
        name: "Farmacia Punal",
        websiteUrl: "https://www.facebook.com/farmacia.punal.albacete",
        phone: "+34 967 000 101",
        sourceUrl: "https://maps.example.invalid/place/itest-facebook-farmacia-punal",
      });
      const wellness = makePlace({
        externalPlaceId: "itest-facebook-c2-burgos",
        name: "c2 Relajacion",
        category: "Centro de bienestar",
        address: "Calle de prueba 2",
        postalCode: "09001",
        province: "Burgos",
        city: "Burgos",
        latitude: 42.3439,
        longitude: -3.6969,
        websiteUrl: "https://www.facebook.com/c2.relajacion.burgos",
        phone: "+34 947 000 102",
      });

      const rawIds = await Promise.all([
        enqueuePlace(fixture.campaignId, pharmacy, randomUUID()),
        enqueuePlace(fixture.campaignId, wellness, randomUUID()),
      ]);
      await processPlace(fixture.campaignId, rawIds[0]!);
      await processPlace(fixture.campaignId, rawIds[1]!);

      const accounts = await db.execute(sql`
        SELECT id, google_place_id, normalized_domain, website_url
        FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND google_place_id IN ('itest-facebook-farmacia-punal', 'itest-facebook-c2-burgos')
        ORDER BY google_place_id
      `);
      expect(accounts.rows).toHaveLength(2);
      expect(accounts.rows.map((row) => (row as { normalized_domain: string | null }).normalized_domain)).toEqual([null, null]);
      expect(accounts.rows.map((row) => (row as { website_url: string }).website_url)).toEqual([
        "https://www.facebook.com/c2.relajacion.burgos",
        "https://www.facebook.com/farmacia.punal.albacete",
      ]);

      const memberships = await db.execute(sql`
        SELECT account_id FROM campaign_memberships WHERE campaign_id = ${fixture.campaignId}::uuid
      `);
      expect(memberships.rows).toHaveLength(2);
      const contacts = await db.execute(sql`
        SELECT id FROM contacts WHERE workspace_id = ${fixture.workspaceId}::uuid
      `);
      expect(contacts.rows).toHaveLength(0);
      reportScenarioResult("A", {
        canonicalAccountIds: accounts.rows.map((row) => (row as { id: string }).id),
        campaignMemberships: memberships.rows.length,
        contacts: contacts.rows.length,
      });
    });

    it("B: keeps unrelated Instagram businesses separate without a shared-domain collision", async () => {
      const first = makePlace({
        externalPlaceId: "itest-instagram-farmacia-menta",
        name: "Farmacia Menta",
        websiteUrl: "https://www.instagram.com/farmacia.menta/",
        phone: "+34 967 000 201",
      });
      const second = makePlace({
        externalPlaceId: "itest-instagram-farmacia-roble",
        name: "Farmacia Roble",
        websiteUrl: "https://www.instagram.com/farmacia.roble/",
        phone: "+34 947 000 202",
        postalCode: "09002",
        province: "Burgos",
        city: "Burgos",
      });
      const firstRaw = await enqueuePlace(fixture.campaignId, first, randomUUID());
      const secondRaw = await enqueuePlace(fixture.campaignId, second, randomUUID());
      await processPlace(fixture.campaignId, firstRaw);
      await processPlace(fixture.campaignId, secondRaw);

      const accounts = await db.execute(sql`
        SELECT id, normalized_domain FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND google_place_id IN ('itest-instagram-farmacia-menta', 'itest-instagram-farmacia-roble')
      `);
      expect(accounts.rows).toHaveLength(2);
      expect(accounts.rows.every((row) => (row as { normalized_domain: string | null }).normalized_domain === null)).toBe(true);
      reportScenarioResult("B", {
        canonicalAccountIds: accounts.rows.map((row) => (row as { id: string }).id),
        normalizedDomains: accounts.rows.map((row) => (row as { normalized_domain: string | null }).normalized_domain),
      });
    });

    it("C: resolves a repeated Place ID to one account and idempotent source provenance", async () => {
      const place = makePlace({
        externalPlaceId: "itest-same-place-id",
        name: "Farmacia Repetida",
        websiteUrl: "https://farmacia-repetida.example",
        phone: "+34 967 000 301",
      });
      const { incoming, account } = identityFor(fixture.workspaceId, place);
      const first = await accountRepository.resolveCanonicalAccount(fixture.workspaceId, incoming, account);
      const second = await accountRepository.resolveCanonicalAccount(fixture.workspaceId, incoming, account);
      expect(first.kind).toBe("createNewAccount");
      expect(second).toMatchObject({ kind: "existingAccount", existingAccountId: (first as { accountId: string }).accountId });

      const candidates = await accountRepository.findCandidateAccountMatches(fixture.workspaceId, incoming);
      expect(accountRepository.selectCanonicalAccountMatch(incoming, candidates)).toMatchObject({
        kind: "existingAccount",
        existingAccountId: (first as { accountId: string }).accountId,
      });

      const source = {
        accountId: (first as { accountId: string }).accountId,
        sourceType: "maps_fast" as const,
        sourceProvider: "neon_identity_test",
        sourceExternalId: place.externalPlaceId,
        sourceUrl: place.sourceUrl,
        rawSnapshot: { kind: "maps", place },
      };
      await accountRepository.insertAccountSource(source);
      await accountRepository.insertAccountSource(source);
      const sources = await db.execute(sql`SELECT id FROM account_sources WHERE account_id = ${source.accountId}::uuid`);
      expect(sources.rows).toHaveLength(1);
      reportScenarioResult("C", {
        firstCanonicalAccountId: (first as { accountId: string }).accountId,
        repeatedCanonicalAccountId: (second as { existingAccountId: string }).existingAccountId,
        sourceRowsAfterDuplicateInsert: sources.rows.length,
      });
    });

    it("D: sends contradictory Place ID and first-party domain evidence to review", async () => {
      const owner = makePlace({
        externalPlaceId: "itest-domain-owner-place",
        name: "Farmacia Grupo Uno",
        websiteUrl: "https://grupo-farmaceutico.example",
        phone: "+34 967 000 401",
      });
      const conflicting = makePlace({
        externalPlaceId: "itest-domain-conflict-place",
        name: "Farmacia Grupo Dos",
        address: "Avenida de prueba 9",
        websiteUrl: "https://www.grupo-farmaceutico.example/sucursal",
        phone: "+34 947 000 402",
      });
      const ownerRaw = await enqueuePlace(fixture.campaignId, owner, randomUUID());
      await processPlace(fixture.campaignId, ownerRaw);
      const conflictRaw = await enqueuePlace(fixture.campaignId, conflicting, randomUUID());
      await processPlace(fixture.campaignId, conflictRaw);

      const incoming = candidateProcessor.deriveIncomingIdentitySignals({ kind: "maps", place: conflicting });
      const candidates = await accountRepository.findCandidateAccountMatches(fixture.workspaceId, incoming);
      expect(accountRepository.selectCanonicalAccountMatch(incoming, candidates)).toMatchObject({ kind: "needsReview" });

      const owners = await db.execute(sql`
        SELECT id FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid AND normalized_domain = 'grupo-farmaceutico.example'
      `);
      expect(owners.rows).toHaveLength(1);
      const rawRows = await db.execute(sql`SELECT processed, account_id FROM raw_candidates WHERE id = ${conflictRaw}::uuid`);
      expect(rawRows.rows[0]).toMatchObject({ processed: true, account_id: null });

      let uniqueViolation: unknown;
      try {
        await db.execute(sql`
          INSERT INTO accounts (workspace_id, canonical_name, normalized_name, business_type, website_url, normalized_domain, google_place_id, normalized_phone)
          VALUES (${fixture.workspaceId}::uuid, 'Synthetic conflicting owner', 'synthetic conflicting owner', 'pharmacy',
            'https://grupo-farmaceutico.example/otra', 'grupo-farmaceutico.example', 'itest-unique-conflict-place', '+34947000403')
        `);
      } catch (error) {
        uniqueViolation = error;
      }
      expect(uniqueViolation).toBeDefined();
      expect(accountRepository.isNormalizedDomainUniqueViolation(uniqueViolation)).toBe(true);
      reportScenarioResult("D", {
        domainOwnerCanonicalAccountId: (owners.rows[0] as { id: string }).id,
        conflictingCandidateAccountId: (rawRows.rows[0] as { account_id: string | null }).account_id,
        conflictingCandidateProcessed: (rawRows.rows[0] as { processed: boolean }).processed,
        duplicateDomainConstraintRejected: uniqueViolation !== undefined,
      });
    });

    it("E: does not attach an unrelated social-profile business to a legacy account", async () => {
      const legacyPlace = makePlace({
        externalPlaceId: "itest-legacy-facebook-place",
        name: "Legacy Farmacia Social",
        websiteUrl: "https://www.facebook.com/legacy.farmacia",
        phone: "+34 967 000 501",
      });
      const legacyRows = await db.execute(sql`
        INSERT INTO accounts (
          workspace_id, canonical_name, normalized_name, business_type, country_code, province, city,
          postal_code, address_line, phone, normalized_phone, website_url, normalized_domain, google_place_id
        ) VALUES (
          ${fixture.workspaceId}::uuid, ${legacyPlace.name}, 'legacy farmacia social', 'pharmacy', 'ES',
          'Albacete', 'Albacete', '02001', 'Calle legacy 1', ${legacyPlace.phone}, '+34967000501',
          ${legacyPlace.websiteUrl}, 'facebook.com', ${legacyPlace.externalPlaceId}
        ) RETURNING id
      `);
      const legacyAccountId = (legacyRows.rows[0] as { id: string }).id;
      await db.execute(sql`
        INSERT INTO contacts (workspace_id, account_id, full_name)
        VALUES (${fixture.workspaceId}::uuid, ${legacyAccountId}::uuid, 'Synthetic legacy contact')
      `);
      await db.execute(sql`
        INSERT INTO campaign_memberships (campaign_id, account_id, stage)
        VALUES (${fixture.campaignId}::uuid, ${legacyAccountId}::uuid, 'discovered')
      `);

      const newPlace = makePlace({
        externalPlaceId: "itest-new-facebook-place",
        name: "Nueva Farmacia Social",
        address: "Calle nueva 7",
        postalCode: "09003",
        province: "Burgos",
        city: "Burgos",
        websiteUrl: "https://www.facebook.com/nueva.farmacia.burgos",
        phone: "+34 947 000 502",
      });
      const rawId = await enqueuePlace(fixture.campaignId, newPlace, randomUUID());
      await processPlace(fixture.campaignId, rawId);

      const legacyRowsAfter = await db.execute(sql`
        SELECT id, normalized_domain, google_place_id FROM accounts WHERE id = ${legacyAccountId}::uuid
      `);
      expect(legacyRowsAfter.rows[0]).toMatchObject({
        id: legacyAccountId,
        normalized_domain: "facebook.com",
        google_place_id: "itest-legacy-facebook-place",
      });
      const newAccountRows = await db.execute(sql`
        SELECT id, normalized_domain, website_url FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid AND google_place_id = 'itest-new-facebook-place'
      `);
      expect(newAccountRows.rows).toHaveLength(1);
      const newAccountId = (newAccountRows.rows[0] as { id: string }).id;
      expect(newAccountRows.rows[0]).toMatchObject({
        normalized_domain: null,
        website_url: "https://www.facebook.com/nueva.farmacia.burgos",
      });
      const contactCounts = await db.execute(sql`
        SELECT account_id, count(*)::int AS count FROM contacts
        WHERE workspace_id = ${fixture.workspaceId}::uuid GROUP BY account_id
      `);
      expect(contactCounts.rows).toEqual([{ account_id: legacyAccountId, count: 1 }]);
      const memberships = await db.execute(sql`
        SELECT account_id FROM campaign_memberships
        WHERE campaign_id = ${fixture.campaignId}::uuid
          AND account_id IN (${legacyAccountId}::uuid, ${newAccountId}::uuid)
        ORDER BY account_id
      `);
      expect(memberships.rows).toHaveLength(2);
      expect(memberships.rows.map((row) => (row as { account_id: string }).account_id)).toContain(legacyAccountId);
      expect(memberships.rows.map((row) => (row as { account_id: string }).account_id)).toContain(newAccountId);
      const sourceRows = await db.execute(sql`
        SELECT source_url, raw_snapshot->'place'->>'websiteUrl' AS profile_url
        FROM account_sources WHERE account_id = ${newAccountId}::uuid
      `);
      expect(sourceRows.rows).toMatchObject([{
        source_url: newPlace.sourceUrl,
        profile_url: newPlace.websiteUrl,
      }]);
      reportScenarioResult("E", {
        legacyCanonicalAccountId: legacyAccountId,
        newCanonicalAccountId: newAccountId,
        legacyContactCount: contactCounts.rows.reduce((total, row) => total + Number((row as { count: number }).count), 0),
        isolatedCampaignMemberships: memberships.rows.length,
      });
    });

    it("G: keeps unrelated pharmacies separate through a shared directory domain", async () => {
      const first = makePlace({
        externalPlaceId: "itest-directory-pharmacy-one",
        name: "Farmacia Directorio Uno",
        websiteUrl: "https://farmaciascerca.es/farmacia/uno",
        phone: "+34 967 000 701",
      });
      const second = makePlace({
        externalPlaceId: "itest-directory-pharmacy-two",
        name: "Farmacia Directorio Dos",
        address: "Calle de prueba 22",
        postalCode: "09022",
        province: "Burgos",
        city: "Burgos",
        latitude: 42.3439,
        longitude: -3.6969,
        websiteUrl: "https://www.farmaciascerca.es/farmacia/dos",
        phone: "+34 947 000 702",
      });
      const firstRaw = await enqueuePlace(fixture.campaignId, first, randomUUID());
      const secondRaw = await enqueuePlace(fixture.campaignId, second, randomUUID());
      await processPlace(fixture.campaignId, firstRaw);
      await processPlace(fixture.campaignId, secondRaw);

      const rows = await db.execute(sql`
        SELECT id, google_place_id, normalized_domain, website_url
        FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND google_place_id IN ('itest-directory-pharmacy-one', 'itest-directory-pharmacy-two')
        ORDER BY google_place_id
      `);
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.map((row) => (row as { normalized_domain: string | null }).normalized_domain)).toEqual([null, null]);
      expect(rows.rows.map((row) => (row as { website_url: string }).website_url)).toEqual([
        "https://farmaciascerca.es/farmacia/uno",
        "https://www.farmaciascerca.es/farmacia/dos",
      ]);
      const memberships = await db.execute(sql`
        SELECT cm.account_id FROM campaign_memberships cm
        JOIN accounts a ON a.id = cm.account_id
        WHERE cm.campaign_id = ${fixture.campaignId}::uuid
          AND a.google_place_id IN ('itest-directory-pharmacy-one', 'itest-directory-pharmacy-two')
      `);
      expect(memberships.rows).toHaveLength(2);
      reportScenarioResult("G", { separateAccounts: rows.rows.length, preservedWebsites: rows.rows.length, campaignMemberships: memberships.rows.length });
    });

    it("H: isolates new directory-domain locations from a contaminated legacy account", async () => {
      const legacyPlace = makePlace({
        externalPlaceId: "itest-legacy-directory-place",
        name: "Legacy Directorio Farmacia",
        websiteUrl: "https://farmaciascerca.es/farmacia/legacy",
        phone: "+34 967 000 801",
      });
      const legacyRows = await db.execute(sql`
        INSERT INTO accounts (
          workspace_id, canonical_name, normalized_name, business_type, country_code, province, city,
          postal_code, address_line, phone, normalized_phone, website_url, normalized_domain, google_place_id
        ) VALUES (
          ${fixture.workspaceId}::uuid, ${legacyPlace.name}, 'legacy directorio farmacia', 'pharmacy', 'ES',
          'Albacete', 'Albacete', '02001', 'Calle legacy 8', ${legacyPlace.phone}, '+34967000801',
          ${legacyPlace.websiteUrl}, 'farmaciascerca.es', ${legacyPlace.externalPlaceId}
        ) RETURNING id
      `);
      const legacyAccountId = (legacyRows.rows[0] as { id: string }).id;
      await db.execute(sql`
        INSERT INTO contacts (workspace_id, account_id, full_name)
        VALUES (${fixture.workspaceId}::uuid, ${legacyAccountId}::uuid, 'Synthetic directory legacy contact')
      `);
      await db.execute(sql`
        INSERT INTO campaign_memberships (campaign_id, account_id, stage)
        VALUES (${fixture.campaignId}::uuid, ${legacyAccountId}::uuid, 'discovered')
      `);

      const newPlace = makePlace({
        externalPlaceId: "itest-new-directory-place",
        name: "Nueva Farmacia Directorio",
        address: "Calle nueva 9",
        postalCode: "09009",
        province: "Burgos",
        city: "Burgos",
        latitude: 42.3439,
        longitude: -3.6969,
        websiteUrl: "https://www.farmaciascerca.es/farmacia/nueva",
        phone: "+34 947 000 802",
      });
      const rawId = await enqueuePlace(fixture.campaignId, newPlace, randomUUID());
      await processPlace(fixture.campaignId, rawId);

      const legacyAfter = await db.execute(sql`
        SELECT id, normalized_domain, google_place_id FROM accounts WHERE id = ${legacyAccountId}::uuid
      `);
      expect(legacyAfter.rows[0]).toMatchObject({
        id: legacyAccountId,
        normalized_domain: "farmaciascerca.es",
        google_place_id: "itest-legacy-directory-place",
      });
      const newRows = await db.execute(sql`
        SELECT id, normalized_domain, website_url FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid AND google_place_id = 'itest-new-directory-place'
      `);
      expect(newRows.rows).toHaveLength(1);
      expect(newRows.rows[0]).toMatchObject({
        normalized_domain: null,
        website_url: newPlace.websiteUrl,
      });
      const contactRows = await db.execute(sql`
        SELECT account_id FROM contacts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND account_id IN (${legacyAccountId}::uuid, ${(newRows.rows[0] as { id: string }).id}::uuid)
      `);
      expect(contactRows.rows).toEqual([{ account_id: legacyAccountId }]);
      const membershipRows = await db.execute(sql`
        SELECT account_id FROM campaign_memberships
        WHERE campaign_id = ${fixture.campaignId}::uuid
          AND account_id IN (${legacyAccountId}::uuid, ${(newRows.rows[0] as { id: string }).id}::uuid)
      `);
      expect(membershipRows.rows).toHaveLength(2);
      reportScenarioResult("H", {
        legacyAccountPreserved: legacyAfter.rows.length === 1,
        newAccountWebsitePreserved: (newRows.rows[0] as { website_url: string }).website_url === newPlace.websiteUrl,
        contactsKeptOnLegacy: contactRows.rows.length === 1,
        isolatedMemberships: membershipRows.rows.length,
      });
    });

    it("I: concurrently creates distinct chain locations while preserving shared source fields", async () => {
      const first = makePlace({
        externalPlaceId: "itest-chain-location-one",
        name: "Herbolario Cadena Albacete",
        address: "Calle cadena 1",
        postalCode: "02011",
        websiteUrl: "https://www.herbolarionavarro.es/tiendas/albacete",
        phone: "+34 967 000 901",
      });
      const second = makePlace({
        externalPlaceId: "itest-chain-location-two",
        name: "Herbolario Cadena Burgos",
        address: "Calle cadena 2",
        postalCode: "09012",
        province: "Burgos",
        city: "Burgos",
        latitude: 42.3439,
        longitude: -3.6969,
        websiteUrl: "https://herbolarionavarro.es/tiendas/burgos",
        phone: "+34 967 000 901",
      });
      const firstIdentity = identityFor(fixture.workspaceId, first);
      const secondIdentity = identityFor(fixture.workspaceId, second);
      const results = await Promise.all([
        accountRepository.resolveCanonicalAccount(fixture.workspaceId, firstIdentity.incoming, firstIdentity.account),
        accountRepository.resolveCanonicalAccount(fixture.workspaceId, secondIdentity.incoming, secondIdentity.account),
      ]);
      expect(results.map((result) => result.kind)).toEqual(["createNewAccount", "createNewAccount"]);

      const rows = await db.execute(sql`
        SELECT google_place_id, normalized_domain, normalized_phone, website_url, phone
        FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND google_place_id IN ('itest-chain-location-one', 'itest-chain-location-two')
        ORDER BY google_place_id
      `);
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.filter((row) => (row as { normalized_domain: string | null }).normalized_domain !== null)).toHaveLength(1);
      expect(rows.rows.filter((row) => (row as { normalized_phone: string | null }).normalized_phone !== null)).toHaveLength(1);
      expect(rows.rows.every((row) => Boolean((row as { website_url: string | null }).website_url))).toBe(true);
      expect(rows.rows.every((row) => Boolean((row as { phone: string | null }).phone))).toBe(true);
      reportScenarioResult("I", {
        concurrentCreateOutcomes: results.map((result) => result.kind),
        canonicalDomainOwners: rows.rows.filter((row) => (row as { normalized_domain: string | null }).normalized_domain !== null).length,
        canonicalPhoneOwners: rows.rows.filter((row) => (row as { normalized_phone: string | null }).normalized_phone !== null).length,
        sourceFieldsRetained: rows.rows.every((row) => Boolean((row as { website_url: string | null; phone: string | null }).website_url && (row as { phone: string | null }).phone)),
      });
    });

    it("J: routes a conflicting Place ID with a shared phone and no location evidence to review", async () => {
      const owner = makePlace({
        externalPlaceId: "itest-phone-conflict-owner",
        name: "Farmacia Telefono Propio",
        websiteUrl: "https://phone-owner.example.es",
        phone: "+34 967 000 951",
      });
      const conflicting = makePlace({
        externalPlaceId: "itest-phone-conflict-other",
        name: "Farmacia Telefono Distinto",
        websiteUrl: "https://phone-other.example.es",
        phone: owner.phone,
      });
      const ownerIdentity = identityFor(fixture.workspaceId, owner);
      const conflictingIdentity = identityFor(fixture.workspaceId, conflicting);
      const first = await accountRepository.resolveCanonicalAccount(fixture.workspaceId, ownerIdentity.incoming, ownerIdentity.account);
      expect(first.kind).toBe("createNewAccount");
      await expect(accountRepository.resolveCanonicalAccount(
        fixture.workspaceId,
        conflictingIdentity.incoming,
        conflictingIdentity.account,
      )).resolves.toMatchObject({ kind: "needsReview", matchedSignal: "conflicting_normalized_phone" });

      const rows = await db.execute(sql`
        SELECT google_place_id FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND google_place_id IN ('itest-phone-conflict-owner', 'itest-phone-conflict-other')
      `);
      expect(rows.rows).toEqual([{ google_place_id: "itest-phone-conflict-owner" }]);
      reportScenarioResult("J", { ownerRows: rows.rows.length, conflictingPlaceAutomaticallyCreated: false });
    });

    it("K: preserves a true first-party single-location domain match", async () => {
      const owner = makePlace({
        externalPlaceId: "itest-first-party-owner-place",
        name: "Farmacia First Party Owner",
        websiteUrl: "https://single-location-pharmacy.example.es",
        phone: "+34 967 000 961",
      });
      const ownerIdentity = identityFor(fixture.workspaceId, owner);
      const created = await accountRepository.resolveCanonicalAccount(
        fixture.workspaceId,
        ownerIdentity.incoming,
        ownerIdentity.account,
      );
      expect(created.kind).toBe("createNewAccount");

      const domainOnlyIncoming = {
        ...ownerIdentity.incoming,
        normalizedName: "pharmacy listing without place identity",
        googlePlaceId: null,
        normalizedPhone: null,
        normalizedAddress: null,
        postalCode: null,
        latitude: null,
        longitude: null,
      };
      const domainOnlyAccount = {
        ...ownerIdentity.account,
        canonicalName: "Pharmacy Listing Without Place Identity",
        normalizedName: domainOnlyIncoming.normalizedName,
        googlePlaceId: null,
        normalizedPhone: null,
        normalizedAddress: null,
        postalCode: null,
        latitude: null,
        longitude: null,
      };
      await expect(accountRepository.resolveCanonicalAccount(
        fixture.workspaceId,
        domainOnlyIncoming,
        domainOnlyAccount,
      )).resolves.toMatchObject({
        kind: "existingAccount",
        existingAccountId: (created as { accountId: string }).accountId,
        matchedSignal: "normalized_domain",
      });

      const rows = await db.execute(sql`
        SELECT id FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND normalized_domain = 'single-location-pharmacy.example.es'
      `);
      expect(rows.rows).toHaveLength(1);
      reportScenarioResult("K", { canonicalAccountRows: rows.rows.length, domainMatchResolved: true });
    });

    it("F: concurrent real resolver transactions converge on one canonical account", async () => {
      const place = makePlace({
        externalPlaceId: "itest-concurrent-place-id",
        name: "Farmacia Concurrente",
        websiteUrl: "https://farmacia-concurrente.example",
        phone: "+34 967 000 601",
      });
      const { incoming, account } = identityFor(fixture.workspaceId, place);
      const [first, second] = await Promise.all([
        accountRepository.resolveCanonicalAccount(fixture.workspaceId, incoming, account),
        accountRepository.resolveCanonicalAccount(fixture.workspaceId, incoming, account),
      ]);
      const accountIds = [
        first.kind === "createNewAccount" ? first.accountId : first.kind === "existingAccount" ? first.existingAccountId : null,
        second.kind === "createNewAccount" ? second.accountId : second.kind === "existingAccount" ? second.existingAccountId : null,
      ];
      expect(accountIds[0]).toBeTruthy();
      expect(accountIds[1]).toBe(accountIds[0]);
      expect([first.kind, second.kind].sort()).toEqual(["createNewAccount", "existingAccount"].sort());
      const rows = await db.execute(sql`
        SELECT id FROM accounts
        WHERE workspace_id = ${fixture.workspaceId}::uuid AND google_place_id = 'itest-concurrent-place-id'
      `);
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { id: string }).id).toBe(accountIds[0]);
      reportScenarioResult("F", {
        transactionResults: accountIds,
        canonicalAccountId: accountIds[0],
        canonicalAccountRows: rows.rows.length,
        resolverOutcomes: [first.kind, second.kind],
      });
    });
  });
}