# infrastructure/providers/email-verification

`EMAIL_VERIFICATION_PROVIDER` selects `disabled` (default), `mock`, or
`millionverifier`. The real adapter uses the documented MillionVerifier
Single API and requires `MILLIONVERIFIER_API_KEY`; it applies bounded
concurrency and a transport timeout. Its estimated daily spend ceiling is
configurable with `EMAIL_VERIFICATION_DAILY_COST_LIMIT_USD` (default `$1`).

Provider keys are read only by the server-side factory and are never included
in provider-run metadata or dashboard metrics.
