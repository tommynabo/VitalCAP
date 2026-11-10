# Canonical Identity Historical Triage

## Scope

This document records the supplied read-only Production audit baseline and a safe follow-up process. This agent did not authenticate to Neon or query Production during this task. The attached audit figures are treated as externally supplied evidence, not independently revalidated here.

No historical links, campaigns, imports, suppression entries, or schema were changed. No provider calls, imports, emails, or discovery jobs were initiated.

## Supplied Baseline

- RAW candidates with a source Google Place ID different from the linked canonical account: 1,475.
- Distinct canonical accounts in that population: 259.
- Mismatches involving common social-platform hosts: 343.
- Legacy Farmacias Maps Fast: 1,290 discrepancies.
- Legacy Farmacias Maps Deep: 184 discrepancies.
- New Wellness: 1 discrepancy.
- Related Instantly records: 49 `instantly_added`, 4 `deferred`, and 1 `skipped_existing`.
- All 49 `instantly_added` records in that population are attributed to legacy campaigns.
- Confirmed association: RAW `c61caa5b-6cb3-4ac0-9918-b123c3ffa60e`, the Burgos business `c2 Relajación & Recuperación *'SanArT'* #c2, linked to Albacete account `05af8de8-4670-4036-a928-999a12311f61` (`Farmacia Puñal`) through `facebook.com`.
- Reported collision groups: Farmacia Puñal, 161 RAW records / 134 distinct source Place IDs; Farmacia Condomina 36, 161 / 129, associated with `instagram.com`.

Different Place IDs are an investigation signal, not proof of a false association. The categories in [the SELECT-only triage script](../scripts/canonical-identity-historical-triage.sql) deliberately require corroborating evidence for suspected collisions and reserve confirmed status for the supplied case.

## Dry-Run Proposal

For the confirmed RAW record, review the exact RAW payload and source history against the current canonical account. The proposed repair candidate is limited to re-evaluating that RAW-to-account association and, only after confirming the correct canonical destination, associating the RAW/source evidence with that destination. Do not move or delete account-level contacts, verified email points, suppression records, memberships, outreach history, or Instantly records as a side effect. Those relationships need independent attribution review; preserve all of them until an explicitly approved per-record plan identifies their true owner.

For the other 1,474 discrepancies, classify each relationship as `HIGH_CONFIDENCE_SUSPECTED_COLLISION`, `POSSIBLE_MULTI_LOCATION`, `LEGITIMATE_REPEATED_BUSINESS`, or `INSUFFICIENT_EVIDENCE` using Place IDs, names, phones, address/postal data, geography, profile URLs, domain ownership, source history, memberships, contacts, and import history. The supplied aggregate counts do not identify the exact rows needed for those decisions.

## Instantly And Containment

The 49 `instantly_added` rows are an investigation population, not 49 confirmed wrong imports. An import status, upload timestamp, or provider lead ID does not prove that an email was sent. The local SELECT script reports local import and outreach event states without selecting private email addresses. Provider-side send status remains unverified and requires an authorized, read-only check in Instantly.

The supplied evidence establishes historical imports on legacy campaigns, but does not establish that a specific active workflow is currently importing from a misattributed account. No targeted containment action can be justified from the available evidence. Do not globally pause legacy campaigns. If a current feed is independently confirmed, identify its campaign and exact source account first, then seek approval for the narrowest containment action.

## Unavailable Evidence

- Neon project/branch authentication and exact campaign IDs were not re-tested; Production was not queried.
- The per-record 1,475-row inventory, source/account evidence, memberships, contacts, suppression links, and exact Instantly relationships are unavailable to this agent.
- The two reported large collision groups are aggregate-only here; their member RAW IDs and provenance are unavailable.
- Actual Instantly send/delivery status and any currently active import workflow are unavailable.
- No isolated PostgreSQL server or Docker runtime was available locally, so database uniqueness, SQL resolver execution, and concurrent insert behavior were not exercised against PostgreSQL.

## Controlled Next Steps

1. On a separate, authenticated read-only session, verify the Neon project and branch and the four rollout campaign IDs before running the SELECT-only script. Confirm the campaign names used by its filters.
2. Export the query results without email addresses or secrets. Have an operator review every category and resolve ambiguous locations and company chains.
3. Independently inspect Instantly provider-side send state for the 49 imports. Do not infer sends from local import statuses.
4. Produce a per-record repair mapping and before/after counts. Preserve account-level outreach and suppression history unless ownership is proven and separately approved.
5. Obtain explicit approval, backup confirmation, and a separate controlled execution plan before any historical data mutation.
6. Keep forward-code deployment and historical repair as separate gated operations. Run the four-niche E2E only after the code review, PostgreSQL gate, deployment health checks, and historical-risk approvals are complete.

`HISTORICAL_REPAIR_EXECUTED=NO`