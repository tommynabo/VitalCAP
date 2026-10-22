# Instantly Setter Inbox Contract

Verified against the current official Instantly API v2 documentation on 2026-10-22:

- `INSTANTLY_INBOX_LIST_ENDPOINT=GET /api/v2/emails`
  - Filters: `email_type=received`, configured `campaign_id`, `min_timestamp_created`, `limit` (maximum 100), and cursor `starting_after`.
  - Response pagination: `items` and `next_starting_after`.
  - Rate limit documented by Instantly: 20 requests per minute.
- `INSTANTLY_EMAIL_DETAIL_ENDPOINT=GET /api/v2/emails/{id}`
  - Used when a list response body is unavailable or marked as an excerpt.
- `INSTANTLY_REPLY_ENDPOINT=POST /api/v2/emails/reply`
  - Required fields: `eaccount`, `reply_to_uuid`, `subject`, and `body`; VitalCAP sends `body.text`.
  - The reply target is the provider email `id`; HTTP 2xx means accepted, not confirmed sent.

Official references:

- https://developer.instantly.ai/api-reference/email/list-email
- https://developer.instantly.ai/api-reference/email/get-email
- https://developer.instantly.ai/api-reference/email/reply-to-an-email
- https://developer.instantly.ai/guides/webhook-events

Webhook remains the primary low-latency ingestion path. Reconciliation uses the same `InboundEmailReply` and `processInstantlyInboundReply()` path, with provider-ID deduplication, a persisted per-campaign cursor, a one-hour overlap, and a 100-message per-run ceiling. Scheduled reconciliation runs every ten minutes. The owner-only repair endpoint is `POST /api/admin/instantly-inbox-reconcile` with `lookbackHours` (1-168, default 72) and `maxMessages` (1-100, default 100).
