-- Read-only historical identity triage. Every executable statement is SELECT.
-- Run only against an independently verified, read-only database session.
-- Campaign names are from the supplied audit baseline; confirm them against
-- the verified campaign IDs before broadening or executing this script.

WITH target_campaigns AS (
  SELECT id, name
  FROM campaigns
  WHERE lower(name) IN (
    'legacy farmacias maps fast',
    'legacy farmacias maps deep',
    'new wellness'
  )
), candidates AS (
  SELECT
    c.name AS campaign_name,
    r.id AS raw_candidate_id,
    r.account_id,
    a.canonical_name AS account_name,
    a.google_place_id AS account_place_id,
    a.normalized_domain AS account_domain,
    a.normalized_phone AS account_normalized_phone,
    a.phone AS account_phone,
    a.normalized_address AS account_address,
    a.city AS account_city,
    a.postal_code AS account_postal_code,
    COALESCE(
      r.raw_payload #>> '{place,externalPlaceId}',
      r.raw_payload #>> '{place,googlePlaceId}',
      r.raw_payload ->> 'googlePlaceId'
    ) AS source_place_id,
    r.raw_payload #>> '{place,name}' AS source_name,
    r.raw_payload #>> '{place,address}' AS source_address,
    r.raw_payload #>> '{place,city}' AS source_city,
    r.raw_payload #>> '{place,postalCode}' AS source_postal_code,
    r.raw_payload #>> '{place,phone}' AS source_phone,
    r.raw_payload #>> '{place,websiteUrl}' AS source_website_url,
    NULLIF((regexp_match(
      lower(r.raw_payload #>> '{place,websiteUrl}'),
      '^https?://([^/:?#]+)'
    ))[1], '') AS source_host,
    NULLIF(r.raw_payload #>> '{place,latitude}', '')::double precision AS source_latitude,
    NULLIF(r.raw_payload #>> '{place,longitude}', '')::double precision AS source_longitude,
    a.latitude AS account_latitude,
    a.longitude AS account_longitude,
    CASE
      WHEN a.id IS NULL THEN 'no_canonical_account'
      WHEN COALESCE(
        NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
        a.normalized_domain
      ) IN ('facebook.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'youtube.com', 'linktr.ee')
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.facebook.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.instagram.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.linkedin.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.tiktok.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.youtube.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.linktr.ee'
        THEN 'social_platform'
      WHEN COALESCE(
        NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
        a.normalized_domain
      ) IN ('sites.google.com', 'wixsite.com', 'wordpress.com', 'blogspot.com')
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.sites.google.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.wixsite.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.wordpress.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.blogspot.com'
        THEN 'site_builder'
      WHEN COALESCE(
        NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
        a.normalized_domain
      ) IN ('google.com', 'yelp.com', 'tripadvisor.com', 'paginasamarillas.es', 'cylex.es', 'infobel.com')
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.yelp.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.tripadvisor.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.google.com'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.paginasamarillas.es'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.cylex.es'
        OR COALESCE(
          NULLIF((regexp_match(lower(r.raw_payload #>> '{place,websiteUrl}'), '^https?://([^/:?#]+)'))[1], ''),
          a.normalized_domain
        ) LIKE '%.infobel.com'
        THEN 'directory'
      ELSE 'first_party_candidate'
    END AS domain_class
  FROM raw_candidates r
  JOIN target_campaigns c ON c.id = r.campaign_id
  LEFT JOIN accounts a ON a.id = r.account_id
), signals AS (
  SELECT
    candidates.*,
    (source_place_id IS NOT NULL AND account_place_id IS NOT NULL AND source_place_id <> account_place_id) AS place_id_conflict,
    (
      NULLIF(right(regexp_replace(COALESCE(source_phone, ''), '[^0-9]', '', 'g'), 9), '') IS NOT NULL
      AND NULLIF(right(regexp_replace(COALESCE(account_normalized_phone, account_phone, ''), '[^0-9]', '', 'g'), 9), '') IS NOT NULL
      AND right(regexp_replace(source_phone, '[^0-9]', '', 'g'), 9)
        <> right(regexp_replace(COALESCE(account_normalized_phone, account_phone), '[^0-9]', '', 'g'), 9)
    ) AS phone_conflict,
    (source_name IS NOT NULL AND account_name IS NOT NULL AND lower(trim(source_name)) <> lower(trim(account_name))) AS name_conflict,
    (
      (source_city IS NOT NULL AND account_city IS NOT NULL AND lower(trim(source_city)) <> lower(trim(account_city)))
      OR (source_postal_code IS NOT NULL AND account_postal_code IS NOT NULL AND source_postal_code <> account_postal_code)
      OR (source_address IS NOT NULL AND account_address IS NOT NULL
        AND lower(regexp_replace(trim(source_address), '[[:space:],.]', '', 'g'))
          <> lower(regexp_replace(trim(account_address), '[[:space:],.]', '', 'g')))
    ) AS physical_location_conflict,
    CASE
      WHEN source_latitude IS NULL OR source_longitude IS NULL OR account_latitude IS NULL OR account_longitude IS NULL THEN NULL
      ELSE 6371000 * 2 * asin(sqrt(least(1.0,
        sin(radians(account_latitude - source_latitude) / 2)^2
        + cos(radians(source_latitude)) * cos(radians(account_latitude))
        * sin(radians(account_longitude - source_longitude) / 2)^2
      )))
    END AS distance_meters
  FROM candidates
), classified AS (
  SELECT signals.*,
    CASE
      WHEN raw_candidate_id = 'c61caa5b-6cb3-4ac0-9918-b123c3ffa60e'::uuid
        AND account_id = '05af8de8-4670-4036-a928-999a12311f61'::uuid
        THEN 'CONFIRMED_FALSE_ASSOCIATION'
      WHEN place_id_conflict
        AND domain_class = 'social_platform'
        AND name_conflict AND phone_conflict AND physical_location_conflict
        THEN 'HIGH_CONFIDENCE_SUSPECTED_COLLISION'
      WHEN place_id_conflict
        AND domain_class = 'first_party_candidate'
        AND physical_location_conflict
        THEN 'POSSIBLE_MULTI_LOCATION'
      WHEN source_place_id IS NOT NULL AND source_place_id = account_place_id
        THEN 'LEGITIMATE_REPEATED_BUSINESS'
      ELSE 'INSUFFICIENT_EVIDENCE'
    END AS triage_category
  FROM signals
)
SELECT campaign_name, triage_category, count(*) AS raw_candidates,
       count(DISTINCT account_id) AS canonical_accounts
FROM classified
GROUP BY campaign_name, triage_category
ORDER BY campaign_name, triage_category;

WITH target_campaigns AS (
  SELECT id, name
  FROM campaigns
  WHERE lower(name) IN (
    'legacy farmacias maps fast',
    'legacy farmacias maps deep',
    'new wellness'
  )
)
SELECT
  a.id AS account_id,
  a.canonical_name,
  a.city,
  a.normalized_domain,
  count(r.id) AS linked_raw_candidates,
  count(DISTINCT COALESCE(
    r.raw_payload #>> '{place,externalPlaceId}',
    r.raw_payload #>> '{place,googlePlaceId}',
    r.raw_payload ->> 'googlePlaceId'
  )) AS distinct_source_place_ids,
  count(r.id) FILTER (
    WHERE COALESCE(
      r.raw_payload #>> '{place,externalPlaceId}',
      r.raw_payload #>> '{place,googlePlaceId}',
      r.raw_payload ->> 'googlePlaceId'
    ) IS NOT NULL
      AND a.google_place_id IS NOT NULL
      AND COALESCE(
        r.raw_payload #>> '{place,externalPlaceId}',
        r.raw_payload #>> '{place,googlePlaceId}',
        r.raw_payload ->> 'googlePlaceId'
      ) <> a.google_place_id
  ) AS place_id_discrepancies
FROM accounts a
JOIN raw_candidates r ON r.account_id = a.id
JOIN target_campaigns c ON c.id = r.campaign_id
WHERE a.id = '05af8de8-4670-4036-a928-999a12311f61'::uuid
   OR lower(a.canonical_name) LIKE '%farmacia condomina 36%'
GROUP BY a.id, a.canonical_name, a.city, a.normalized_domain
ORDER BY place_id_discrepancies DESC, a.canonical_name;

SELECT
  r.id AS raw_candidate_id,
  r.account_id AS current_account_id,
  r.campaign_id,
  r.source_url,
  r.raw_payload #>> '{place,name}' AS source_business_name,
  r.raw_payload #>> '{place,city}' AS source_city,
  r.raw_payload #>> '{place,externalPlaceId}' AS source_place_id,
  r.raw_payload #>> '{place,websiteUrl}' AS source_website_url,
  a.canonical_name AS current_account_name,
  a.city AS current_account_city,
  a.google_place_id AS current_account_place_id,
  a.normalized_domain AS current_account_domain,
  (
    SELECT count(*) FROM account_sources s WHERE s.account_id = a.id
  ) AS account_source_count,
  (
    SELECT count(*) FROM campaign_memberships m WHERE m.account_id = a.id
  ) AS account_membership_count,
  (
    SELECT count(*) FROM contacts c WHERE c.account_id = a.id
  ) AS account_contact_count,
  (
    SELECT count(*) FROM contact_points cp WHERE cp.account_id = a.id
  ) AS account_contact_point_count,
  (
    SELECT count(*)
    FROM suppression_entries se
    WHERE se.account_id = a.id
      OR se.contact_point_id IN (SELECT cp.id FROM contact_points cp WHERE cp.account_id = a.id)
  ) AS account_suppression_count
FROM raw_candidates r
JOIN accounts a ON a.id = r.account_id
WHERE r.id = 'c61caa5b-6cb3-4ac0-9918-b123c3ffa60e'::uuid
  AND r.account_id = '05af8de8-4670-4036-a928-999a12311f61'::uuid;

WITH target_case AS (
  SELECT r.account_id
  FROM raw_candidates r
  WHERE r.id = 'c61caa5b-6cb3-4ac0-9918-b123c3ffa60e'::uuid
    AND r.account_id = '05af8de8-4670-4036-a928-999a12311f61'::uuid
)
SELECT 'raw_candidate'::text AS relation_type, r.id::text AS relation_id,
       r.account_id::text AS account_id, r.campaign_id::text AS campaign_id,
       r.processed::text AS state_or_type, NULL::text AS related_id
FROM raw_candidates r JOIN target_case t ON t.account_id = r.account_id
WHERE r.id = 'c61caa5b-6cb3-4ac0-9918-b123c3ffa60e'::uuid
UNION ALL
SELECT 'account_source', s.id::text, s.account_id::text, NULL::text, s.source_type, NULL::text
FROM account_sources s JOIN target_case t ON t.account_id = s.account_id
UNION ALL
SELECT 'campaign_membership', m.id::text, m.account_id::text, m.campaign_id::text, m.stage, m.contact_id::text
FROM campaign_memberships m JOIN target_case t ON t.account_id = m.account_id
UNION ALL
SELECT 'contact', c.id::text, c.account_id::text, NULL::text, c.status, NULL::text
FROM contacts c JOIN target_case t ON t.account_id = c.account_id
UNION ALL
SELECT 'contact_point', cp.id::text, cp.account_id::text, NULL::text, cp.verification_status, cp.contact_id::text
FROM contact_points cp JOIN target_case t ON t.account_id = cp.account_id
UNION ALL
SELECT 'suppression_entry', se.id::text, se.account_id::text, NULL::text, NULL::text, se.contact_point_id::text
FROM suppression_entries se
JOIN target_case t ON se.account_id = t.account_id OR se.contact_point_id IN (
  SELECT cp.id FROM contact_points cp WHERE cp.account_id = t.account_id
)
UNION ALL
SELECT 'instantly_import', i.id::text, i.account_id::text, i.source_campaign_id::text, i.status, i.contact_point_id::text
FROM instantly_lead_imports i JOIN target_case t ON t.account_id = i.account_id
UNION ALL
SELECT 'outreach_queue', q.id::text, q.account_id::text, q.campaign_id::text, q.state, q.contact_point_id::text
FROM outreach_queue q JOIN target_case t ON t.account_id = q.account_id
ORDER BY relation_type, relation_id;

WITH target_accounts AS (
  SELECT DISTINCT r.account_id
  FROM raw_candidates r
  JOIN campaigns c ON c.id = r.campaign_id
  JOIN accounts a ON a.id = r.account_id
  WHERE lower(c.name) IN (
      'legacy farmacias maps fast',
      'legacy farmacias maps deep',
      'new wellness'
    )
    AND r.account_id IS NOT NULL
    AND (
      r.id = 'c61caa5b-6cb3-4ac0-9918-b123c3ffa60e'::uuid
      OR (
        COALESCE(
          r.raw_payload #>> '{place,externalPlaceId}',
          r.raw_payload #>> '{place,googlePlaceId}',
          r.raw_payload ->> 'googlePlaceId'
        ) IS NOT NULL
        AND a.google_place_id IS NOT NULL
        AND COALESCE(
          r.raw_payload #>> '{place,externalPlaceId}',
          r.raw_payload #>> '{place,googlePlaceId}',
          r.raw_payload ->> 'googlePlaceId'
        ) <> a.google_place_id
      )
    )
)
SELECT
  c.name AS source_campaign,
  i.account_id,
  i.source_campaign_id,
  i.provider_campaign_id,
  i.status,
  count(*) AS import_records,
  count(*) FILTER (WHERE i.uploaded_at IS NOT NULL) AS has_uploaded_at,
  count(*) FILTER (WHERE i.provider_lead_id IS NOT NULL) AS has_provider_lead_id
FROM instantly_lead_imports i
JOIN campaigns c ON c.id = i.source_campaign_id
JOIN target_accounts ta ON ta.account_id = i.account_id
GROUP BY c.name, i.account_id, i.source_campaign_id, i.provider_campaign_id, i.status
ORDER BY c.name, i.account_id, i.status;

WITH target_accounts AS (
  SELECT DISTINCT r.account_id
  FROM raw_candidates r
  JOIN campaigns c ON c.id = r.campaign_id
  JOIN accounts a ON a.id = r.account_id
  WHERE lower(c.name) IN (
      'legacy farmacias maps fast',
      'legacy farmacias maps deep',
      'new wellness'
    )
    AND r.account_id IS NOT NULL
    AND (
      r.id = 'c61caa5b-6cb3-4ac0-9918-b123c3ffa60e'::uuid
      OR (
        COALESCE(
          r.raw_payload #>> '{place,externalPlaceId}',
          r.raw_payload #>> '{place,googlePlaceId}',
          r.raw_payload ->> 'googlePlaceId'
        ) IS NOT NULL
        AND a.google_place_id IS NOT NULL
        AND COALESCE(
          r.raw_payload #>> '{place,externalPlaceId}',
          r.raw_payload #>> '{place,googlePlaceId}',
          r.raw_payload ->> 'googlePlaceId'
        ) <> a.google_place_id
      )
    )
)
SELECT
  q.account_id,
  c.name AS campaign_name,
  q.state AS local_outreach_state,
  e.state AS local_event_state,
  count(e.id) AS event_rows,
  min(e.occurred_at) AS first_local_event_at,
  max(e.occurred_at) AS last_local_event_at
FROM outreach_queue q
JOIN target_accounts ta ON ta.account_id = q.account_id
JOIN campaigns c ON c.id = q.campaign_id
LEFT JOIN outreach_events e ON e.outreach_queue_item_id = q.id
GROUP BY q.account_id, c.name, q.state, e.state
ORDER BY q.account_id, c.name, q.state, e.state;