> Normative security requirements and tests live in `../security/SECURITY_PROTOCOL.md` and `../security/SECURITY_REVIEW_CHECKLIST.md`. This file is a summary only.

# Security, Privacy, and Cost

## Security
Use env vars for API keys, server-only provider clients, RLS, least privilege, input validation, SSRF protection (block localhost/private networks and redirects), output escaping, CSRF/auth protections, and audit logs. Never store browser session cookies or credentials in evidence. Treat retrieved webpages and comments as untrusted prompt-injection inputs.

## Privacy
Prefer public business information. Minimize personal data. Do not ingest private group membership, personal profiles, or private messages into a public report. Manual social research should capture a brief relevant observation and source link, with sensitivity controls. Provide retention and deletion mechanisms before public launch.

## Cost
Mock mode default. Per-run request, token, time, and dollar limits. Two-stage scan: cheap identity/website first, deeper research only for promising prospects. Provider costs/configuration must be checked against live docs before deployment; never hardcode a claimed current price.

## Operational safety
Bound crawl depth, concurrency, redirects, retries; respect robots directives where applicable and site terms. No fake bookings, forms, calls, messages, or login automation to restricted platforms. Stop on CAPTCHA/access denial; do not bypass.
