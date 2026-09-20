-- Phase 1 (Prompt 1 §1.9). Synthetic Spanish seed data covering the 7
-- required scenarios. Not applied to any live database — see
-- supabase/migrations/0001_core_schema.sql header note. Uses fixed literal
-- UUIDs (not gen_random_uuid()) purely so this file stays readable and
-- re-runnable idempotently via `on conflict do nothing`.

insert into workspaces (id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'Vitalcap Demo Workspace')
on conflict (id) do nothing;

insert into offers (id, workspace_id, name, company, description, primary_cta, booking_url, approved_commercial_facts, active) values
  (
    'a0000000-0000-0000-0000-000000000201',
    'a0000000-0000-0000-0000-000000000001',
    'Vitalcap',
    'Vitalcap',
    'Suplementos para venta en farmacias y parafarmacias independientes.',
    'book_call_with_sales_director',
    'https://example.com/configure-booking-url',
    '{"pharmacy_share_pct": 51}'::jsonb,
    false
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Independent pharmacy with owner + info email
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, province, city, postal_code,
  website_url, normalized_domain, fit_tier, fit_score, status
) values (
  'a0000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000001',
  'Farmacia Delgado', 'farmacia delgado', 'pharmacy', 'ES', 'Sevilla', 'Sevilla', '41001',
  'https://farmaciadelgado.example.es', 'farmaciadelgado.example.es', 'high', 92, 'outreach_ready'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000111', 'a0000000-0000-0000-0000-000000000101', 'maps_fast', 'mock_maps', 'place_1')
on conflict (id) do nothing;

insert into contacts (id, workspace_id, account_id, first_name, last_name, full_name, job_title, role_type, is_decision_maker, seniority) values
  ('a0000000-0000-0000-0000-000000000121', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000101',
   'Marta', 'Delgado', 'Marta Delgado', 'Titular', 'titular_pharmacist', true, 'owner')
on conflict (id) do nothing;

insert into contact_points (
  id, workspace_id, account_id, contact_id, type, value, normalized_value, label,
  is_generic, is_personal_or_named, priority_score, verification_status, channel_eligibility, status
) values
  ('a0000000-0000-0000-0000-000000000131', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000101',
   'a0000000-0000-0000-0000-000000000121', 'email', 'marta@farmaciadelgado.example.es', 'marta@farmaciadelgado.example.es',
   'owner', false, true, 100, 'valid', 'eligible_email', 'eligible'),
  ('a0000000-0000-0000-0000-000000000132', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000101',
   null, 'email', 'info@farmaciadelgado.example.es', 'info@farmaciadelgado.example.es',
   'generic', true, false, 60, 'valid', 'eligible_email', 'eligible')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Pharmacy with only a generic email
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, province, city, postal_code,
  website_url, normalized_domain, fit_tier, fit_score, status
) values (
  'a0000000-0000-0000-0000-000000000102', 'a0000000-0000-0000-0000-000000000001',
  'Farmacia San Roque', 'farmacia san roque', 'pharmacy', 'ES', 'Valencia', 'Valencia', '46001',
  'https://farmaciasanroque.example.es', 'farmaciasanroque.example.es', 'medium', 70, 'outreach_ready'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000112', 'a0000000-0000-0000-0000-000000000102', 'maps_fast', 'mock_maps', 'place_2')
on conflict (id) do nothing;

insert into contact_points (
  id, workspace_id, account_id, contact_id, type, value, normalized_value, label,
  is_generic, is_personal_or_named, priority_score, verification_status, channel_eligibility, status
) values
  ('a0000000-0000-0000-0000-000000000133', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000102',
   null, 'email', 'info@farmaciasanroque.example.es', 'info@farmaciasanroque.example.es',
   'generic', true, false, 60, 'valid', 'eligible_email', 'eligible')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Herbal shop
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, province, city, postal_code,
  website_url, normalized_domain, fit_tier, fit_score, status
) values (
  'a0000000-0000-0000-0000-000000000103', 'a0000000-0000-0000-0000-000000000001',
  'Herbolario Naturvida', 'herbolario naturvida', 'herbal_shop', 'ES', 'Bizkaia', 'Bilbao', '48001',
  'https://naturvida.example.es', 'naturvida.example.es', 'medium', 65, 'outreach_ready'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000113', 'a0000000-0000-0000-0000-000000000103', 'maps_fast', 'mock_maps', 'place_3')
on conflict (id) do nothing;

insert into contact_points (
  id, workspace_id, account_id, contact_id, type, value, normalized_value, label,
  is_generic, is_personal_or_named, priority_score, verification_status, channel_eligibility, status
) values
  ('a0000000-0000-0000-0000-000000000134', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000103',
   null, 'email', 'contacto@naturvida.example.es', 'contacto@naturvida.example.es',
   'generic', true, false, 65, 'valid', 'eligible_email', 'eligible')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Sports nutrition store
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, province, city, postal_code,
  website_url, normalized_domain, fit_tier, fit_score, status
) values (
  'a0000000-0000-0000-0000-000000000104', 'a0000000-0000-0000-0000-000000000001',
  'Sport Nutrition Zaragoza', 'sport nutrition zaragoza', 'sports_nutrition_store', 'ES', 'Zaragoza', 'Zaragoza', '50001',
  'https://sportnutritionzgz.example.es', 'sportnutritionzgz.example.es', 'medium', 68, 'outreach_ready'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000114', 'a0000000-0000-0000-0000-000000000104', 'maps_fast', 'mock_maps', 'place_4')
on conflict (id) do nothing;

insert into contacts (id, workspace_id, account_id, first_name, last_name, full_name, job_title, role_type, is_decision_maker, seniority) values
  ('a0000000-0000-0000-0000-000000000122', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000104',
   'Iker', 'Zabala', 'Iker Zabala', 'Gerente', 'manager', true, 'senior')
on conflict (id) do nothing;

insert into contact_points (
  id, workspace_id, account_id, contact_id, type, value, normalized_value, label,
  is_generic, is_personal_or_named, priority_score, verification_status, channel_eligibility, status
) values
  ('a0000000-0000-0000-0000-000000000135', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000104',
   'a0000000-0000-0000-0000-000000000122', 'email', 'iker@sportnutritionzgz.example.es', 'iker@sportnutritionzgz.example.es',
   'manager', false, true, 90, 'valid', 'eligible_email', 'eligible')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Duplicate account discovered from two sources (one account, two source rows)
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, province, city, postal_code,
  google_place_id, fit_tier, fit_score, status
) values (
  'a0000000-0000-0000-0000-000000000105', 'a0000000-0000-0000-0000-000000000001',
  'Farmacia Central Bilbao', 'farmacia central bilbao', 'pharmacy', 'ES', 'Bizkaia', 'Bilbao', '48005',
  'place_central_bilbao_5', 'medium', 74, 'outreach_ready'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000115', 'a0000000-0000-0000-0000-000000000105', 'maps_fast', 'mock_maps', 'place_central_bilbao_5'),
  ('a0000000-0000-0000-0000-000000000116', 'a0000000-0000-0000-0000-000000000105', 'google_serp', 'mock_serp', 'serp_central_bilbao_5')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Invalid non-Spain record (rejected by SpainEligibilityService)
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, city, status
) values (
  'a0000000-0000-0000-0000-000000000106', 'a0000000-0000-0000-0000-000000000001',
  'Farmacia Lisboa Centro', 'farmacia lisboa centro', 'pharmacy', 'PT', 'Lisboa', 'rejected_country'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000117', 'a0000000-0000-0000-0000-000000000106', 'maps_fast', 'mock_maps', 'place_6')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Account with two decision makers
-- ---------------------------------------------------------------------------

insert into accounts (
  id, workspace_id, canonical_name, normalized_name, business_type, country_code, province, city, postal_code,
  website_url, normalized_domain, fit_tier, fit_score, status
) values (
  'a0000000-0000-0000-0000-000000000107', 'a0000000-0000-0000-0000-000000000001',
  'Parafarmacia Els Tres Ponts', 'parafarmacia els tres ponts', 'parapharmacy', 'ES', 'Barcelona', 'Barcelona', '08001',
  'https://elstresponts.example.es', 'elstresponts.example.es', 'high', 88, 'outreach_ready'
) on conflict (id) do nothing;

insert into account_sources (id, account_id, source_type, source_provider, source_external_id) values
  ('a0000000-0000-0000-0000-000000000118', 'a0000000-0000-0000-0000-000000000107', 'maps_fast', 'mock_maps', 'place_7')
on conflict (id) do nothing;

insert into contacts (id, workspace_id, account_id, first_name, last_name, full_name, job_title, role_type, is_decision_maker, seniority) values
  ('a0000000-0000-0000-0000-000000000123', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000107',
   'Anna', 'Puig', 'Anna Puig', 'Propietaria', 'owner', true, 'owner'),
  ('a0000000-0000-0000-0000-000000000124', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000107',
   'Jordi', 'Puig', 'Jordi Puig', 'Responsable de compras', 'purchasing_manager', true, 'senior')
on conflict (id) do nothing;

insert into contact_points (
  id, workspace_id, account_id, contact_id, type, value, normalized_value, label,
  is_generic, is_personal_or_named, priority_score, verification_status, channel_eligibility, status
) values
  ('a0000000-0000-0000-0000-000000000136', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000107',
   'a0000000-0000-0000-0000-000000000123', 'email', 'anna@elstresponts.example.es', 'anna@elstresponts.example.es',
   'owner', false, true, 100, 'valid', 'eligible_email', 'eligible'),
  ('a0000000-0000-0000-0000-000000000137', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000107',
   'a0000000-0000-0000-0000-000000000124', 'email', 'jordi@elstresponts.example.es', 'jordi@elstresponts.example.es',
   'purchasing_manager', false, true, 95, 'valid', 'eligible_email', 'eligible')
on conflict (id) do nothing;
