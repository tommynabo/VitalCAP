# services/routing

`contact-priority.ts` implemented in Phase 1 (Prompt 1 §1.5):
`computeStrategicPriority` scores a contact point's strategic priority
(named owner/titular 100 down to a generic fallback), kept strictly separate
from `verificationConfidence` (technical deliverability confidence) — a
high-priority owner email can be risky, a generic `info@` can be valid.

`ChannelRouter` (Phase 3, Prompt 3 §3.2/§3.6) — deterministic endpoint/
channel selection combining this priority with eligibility, sender capacity,
concurrency (never owner + info@ simultaneously by default) and desired
channel mix — is not implemented yet.
