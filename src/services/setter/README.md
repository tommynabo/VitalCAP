# services/setter

Owner: Phase 4 (Prompt 4). Deterministic pre-router, bounded context, Zod-
validated structured output, guardrails against invented commercial/medical
claims, persistent human review, and the disabled autonomy policy engine.

## Runtime

- Configure `LLM_PROVIDER=openai`, `LLM_PROVIDER_API_KEY`, and `LLM_MODEL` for
	the Setter. It does not require `PROSPECT_LLM_MODEL`. A missing key becomes
	a visible `configuration_error` review draft; production cannot use mock.
- Configure `INSTANTLY_WEBHOOK_SECRET` and set the Instantly custom header
	`X-VitalCAP-Webhook-Secret` to the same value. `POST /api/webhooks/instantly`
	accepts `reply_received` and `email_replied`; other all-events deliveries
	are acknowledged as ignored.
- Map `campaign_id` to exactly one campaign's
	`engineConfig.instantlyCampaignId` or `engineConfig.providerCampaignId`.
	The reply email must resolve to exactly one email contact point in that
	campaign's workspace and have a campaign membership.
- Webhook evidence is stored in `setter_webhook_events`; messages, drafts, and
	feedback use the shared conversation tables. Provider thread identifiers,
	`email_id`/reply UUID, and sending account are retained in message metadata.
	Replays are deduplicated before provider construction.
- `approve` and `edit_and_send` send only after the authenticated workspace
	member's decision is persisted. `reject` and `take_over` never send. Every
	provider request is server-side and protected by an atomic conversation-state
	claim; uncertain outcomes are not retried automatically. `AUTO_SEND_ENABLED`
	remains hardcoded false.
