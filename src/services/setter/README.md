# services/setter

Owner: Phase 4 (Prompt 4). Deterministic pre-router, bounded context, Zod-
validated structured output, guardrails against invented commercial/medical
claims, persistent human review, and the disabled autonomy policy engine.

## Runtime

- Configure `LLM_PROVIDER=openai`, `LLM_PROVIDER_API_KEY`, and `LLM_MODEL` for
	the Setter. It does not require `PROSPECT_LLM_MODEL`. A missing key becomes
	a visible `configuration_error` review draft; production cannot use mock.
- Configure `INSTANTLY_WEBHOOK_SECRET` and point the signed inbound
	`email_replied` webhook at `POST /api/webhooks/instantly`. The endpoint
	verifies HMAC-SHA256 over the raw body and requires event/message IDs.
- Map the provider campaign ID to a local campaign ID or to
	`campaign.engineConfig.instantlyCampaignId` (also accepts
	`providerCampaignId`). The reply email must resolve to exactly one email
	contact point in that campaign's workspace and account membership.
- Webhook evidence is stored in `setter_webhook_events`; messages, drafts, and
	feedback use the shared conversation tables. Replays are deduplicated before
	provider construction. Approved and edited replies are persisted for review
	only; this runtime does not send outbound messages.
