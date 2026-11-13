-- Synthetic PostgreSQL integration checks. Run only on a fresh disposable DB
-- after applying the versioned drizzle/*.sql migrations with psql. The test
-- fixtures commit to that disposable DB and are removed with the cluster.
-- No provider APIs, production data, or application credentials are used.

BEGIN;

INSERT INTO workspaces (id, name)
VALUES ('10000000-0000-4000-8000-000000000001', 'Canonical identity PostgreSQL test');

INSERT INTO offers (id, workspace_id, name, company, primary_cta, booking_url)
VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Pharmacy test', 'Test', 'Book', 'https://example.invalid'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Wellness test', 'Test', 'Book', 'https://example.invalid');

INSERT INTO campaigns (id, workspace_id, offer_id, name, engine_type)
VALUES
  ('21000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Pharmacy test', 'maps_fast'),
  ('21000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'Wellness test', 'maps_fast');

INSERT INTO discovery_jobs (id, campaign_id, type)
VALUES
  ('22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'test'),
  ('22000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'test');

INSERT INTO accounts (
  id, workspace_id, canonical_name, normalized_name, business_type,
  city, postal_code, address_line, normalized_address, phone, normalized_phone,
  website_url, normalized_domain, google_place_id
)
VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Farmacia Puñal', 'farmacia punal', 'pharmacy', 'Albacete', '02001', 'Calle Albacete 1', 'calle albacete 1', '+34 967 000 001', '+34967000001', 'https://www.facebook.com/farmacia-punal', NULL, 'place-farmacia-punal'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'c2 Relajación', 'c2 relajacion', 'other_retail', 'Burgos', '09001', 'Calle Burgos 2', 'calle burgos 2', '+34 947 000 002', '+34947000002', 'https://www.facebook.com/sanart-burgos', NULL, 'place-c2-burgos'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Farmacia Instagram A', 'farmacia instagram a', 'pharmacy', 'Madrid', '28001', 'Calle Uno 1', 'calle uno 1', '+34 910 000 003', '+34910000003', 'https://www.instagram.com/farmacia-a', NULL, 'place-instagram-a'),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Farmacia Instagram B', 'farmacia instagram b', 'pharmacy', 'Sevilla', '41001', 'Calle Dos 2', 'calle dos 2', '+34 910 000 004', '+34910000004', 'https://www.instagram.com/farmacia-b', NULL, 'place-instagram-b'),
  ('30000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Farmacia Cadena A', 'farmacia cadena a', 'pharmacy', 'Valencia', '46001', 'Calle Tres 3', 'calle tres 3', '+34 960 000 005', '+34960000005', 'https://farmacia-chain.example.invalid/a', 'farmacia-chain.example.invalid', 'place-chain-a'),
  ('30000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'Legacy Facebook Pharmacy', 'legacy facebook pharmacy', 'pharmacy', 'Toledo', '45001', 'Calle Cuatro 4', 'calle cuatro 4', '+34 925 000 006', '+34925000006', 'https://www.facebook.com/legacy-pharmacy', 'facebook.com', 'place-legacy-facebook');

INSERT INTO account_sources (
  account_id, source_type, source_provider, source_external_id, source_url, raw_snapshot
)
VALUES
  ('30000000-0000-4000-8000-000000000001', 'maps_fast', 'postgres_test', 'place-farmacia-punal', 'https://www.facebook.com/farmacia-punal', '{"case":"facebook-a"}'),
  ('30000000-0000-4000-8000-000000000002', 'maps_fast', 'postgres_test', 'place-c2-burgos', 'https://www.facebook.com/sanart-burgos', '{"case":"facebook-b"}'),
  ('30000000-0000-4000-8000-000000000006', 'maps_fast', 'postgres_test', 'place-legacy-facebook', 'https://www.facebook.com/legacy-pharmacy', '{"case":"legacy"}');

INSERT INTO contacts (id, workspace_id, account_id, full_name)
VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Synthetic pharmacy contact'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', 'Synthetic legacy contact');

INSERT INTO contact_points (id, workspace_id, account_id, contact_id, type, value, normalized_value)
VALUES
  ('41000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'phone', '+34 967 000 001', '+34967000001'),
  ('41000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000002', 'phone', '+34 925 000 006', '+34925000006');

INSERT INTO campaign_memberships (campaign_id, account_id)
VALUES ('21000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001');

INSERT INTO raw_candidates (id, discovery_job_id, campaign_id, engine_type, source_fingerprint, raw_payload, account_id)
VALUES
  ('50000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'maps_fast', 'test-facebook-a', '{"kind":"maps","place":{"name":"Farmacia Puñal","externalPlaceId":"place-farmacia-punal","websiteUrl":"https://www.facebook.com/farmacia-punal"}}', '30000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'maps_fast', 'test-facebook-b', '{"kind":"maps","place":{"name":"c2 Relajación","externalPlaceId":"place-c2-burgos","websiteUrl":"https://www.facebook.com/sanart-burgos"}}', '30000000-0000-4000-8000-000000000002');

DO $$
DECLARE
  actual_count integer;
  match_resolution text;
BEGIN
  SELECT count(*) INTO actual_count
  FROM accounts
  WHERE workspace_id = '10000000-0000-4000-8000-000000000001'
    AND id IN ('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002')
    AND normalized_domain IS NULL;
  IF actual_count <> 2 THEN RAISE EXCEPTION 'Facebook shared-host accounts were not independently persisted'; END IF;

  IF (SELECT count(*) FROM contact_points WHERE account_id = '30000000-0000-4000-8000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'Facebook business B inherited business A contact points';
  END IF;
  IF (SELECT count(*) FROM campaign_memberships WHERE account_id = '30000000-0000-4000-8000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'Facebook business B inherited business A campaign membership';
  END IF;
  IF (SELECT count(*) FROM raw_candidates WHERE account_id = '30000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'Facebook RAW candidate was not independently linked';
  END IF;
  IF (SELECT count(*) FROM account_sources WHERE account_id IN ('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002') AND source_url LIKE 'https://www.facebook.com/%') <> 2 THEN
    RAISE EXCEPTION 'Original Facebook profile URLs were not retained as source evidence';
  END IF;

  IF (SELECT count(*) FROM accounts WHERE id IN ('30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004') AND normalized_domain IS NULL) <> 2 THEN
    RAISE EXCEPTION 'Instagram shared-host accounts were not independently persisted';
  END IF;

  INSERT INTO accounts (workspace_id, canonical_name, normalized_name, business_type, google_place_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'Repeated Farmacia Puñal', 'farmacia punal', 'pharmacy', 'place-farmacia-punal')
  ON CONFLICT DO NOTHING;
  IF (SELECT count(*) FROM accounts WHERE workspace_id = '10000000-0000-4000-8000-000000000001' AND google_place_id = 'place-farmacia-punal') <> 1 THEN
    RAISE EXCEPTION 'Exact Place ID did not remain unique';
  END IF;

  INSERT INTO account_sources (account_id, source_type, source_provider, source_external_id)
  VALUES ('30000000-0000-4000-8000-000000000001', 'maps_fast', 'postgres_test', 'place-farmacia-punal')
  ON CONFLICT DO NOTHING;
  INSERT INTO account_sources (account_id, source_type, source_provider, source_external_id)
  VALUES ('30000000-0000-4000-8000-000000000001', 'maps_fast', 'postgres_test', 'place-farmacia-punal')
  ON CONFLICT DO NOTHING;
  IF (SELECT count(*) FROM account_sources WHERE account_id = '30000000-0000-4000-8000-000000000001' AND source_type = 'maps_fast' AND source_provider = 'postgres_test' AND source_external_id = 'place-farmacia-punal') <> 1 THEN
    RAISE EXCEPTION 'Repeated source insertion was not idempotent';
  END IF;

  INSERT INTO processing_jobs (campaign_id, type, idempotency_key)
  VALUES ('21000000-0000-4000-8000-000000000001', 'process_raw_candidate', 'test-exact-place-id')
  ON CONFLICT DO NOTHING;
  INSERT INTO processing_jobs (campaign_id, type, idempotency_key)
  VALUES ('21000000-0000-4000-8000-000000000001', 'process_raw_candidate', 'test-exact-place-id')
  ON CONFLICT DO NOTHING;
  IF (SELECT count(*) FROM processing_jobs WHERE idempotency_key = 'test-exact-place-id') <> 1 THEN
    RAISE EXCEPTION 'Repeated processing-job insertion was not idempotent';
  END IF;

  SELECT CASE
    WHEN a.google_place_id <> 'place-chain-b' AND a.normalized_domain = 'farmacia-chain.example.invalid' THEN 'needsReview'
    ELSE 'unexpected'
  END INTO match_resolution
  FROM accounts a
  WHERE a.id = '30000000-0000-4000-8000-000000000005';
  IF match_resolution <> 'needsReview' THEN RAISE EXCEPTION 'Conflicting Place ID and business domain did not require review'; END IF;

  BEGIN
    INSERT INTO accounts (workspace_id, canonical_name, normalized_name, business_type, normalized_domain, google_place_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Farmacia Cadena B', 'farmacia cadena b', 'pharmacy', 'farmacia-chain.example.invalid', 'place-chain-b');
    RAISE EXCEPTION 'Expected first-party unique-domain constraint to reject an unresolved second branch';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF (SELECT count(*) FROM accounts WHERE workspace_id = '10000000-0000-4000-8000-000000000001' AND normalized_domain = 'farmacia-chain.example.invalid') <> 1 THEN
    RAISE EXCEPTION 'First-party unique-domain owner changed after a conflicting insert';
  END IF;

  INSERT INTO accounts (workspace_id, canonical_name, normalized_name, business_type, website_url, normalized_domain, google_place_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'New Facebook Pharmacy', 'new facebook pharmacy', 'pharmacy', 'https://www.facebook.com/new-pharmacy', NULL, 'place-new-facebook');
  IF (SELECT count(*) FROM accounts WHERE id = '30000000-0000-4000-8000-000000000006' AND normalized_domain = 'facebook.com' AND website_url = 'https://www.facebook.com/legacy-pharmacy') <> 1 THEN
    RAISE EXCEPTION 'Legacy facebook.com identity or URL was modified';
  END IF;
  IF (SELECT count(*) FROM accounts WHERE workspace_id = '10000000-0000-4000-8000-000000000001' AND google_place_id IN ('place-legacy-facebook', 'place-new-facebook')) <> 2 THEN
    RAISE EXCEPTION 'New Facebook business was fused with the legacy account';
  END IF;
    IF (SELECT count(*) FROM contacts WHERE account_id = '30000000-0000-4000-8000-000000000006') <> 1
      OR (SELECT count(*) FROM contact_points WHERE account_id = '30000000-0000-4000-8000-000000000006') <> 1
      OR (SELECT count(*) FROM account_sources WHERE account_id = '30000000-0000-4000-8000-000000000006') <> 1 THEN
    RAISE EXCEPTION 'Legacy contact/source evidence changed unexpectedly';
  END IF;
END $$;

COMMIT;