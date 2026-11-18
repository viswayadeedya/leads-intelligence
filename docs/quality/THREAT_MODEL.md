# Threat Model

## Threats
- Prompt injection from websites/reviews/social content
- Wrong company attribution due to duplicate names
- PII/private-group disclosure in shared reports
- SSRF through arbitrary website URLs
- API credential exposure
- LLM hallucinations and unsupported ROI estimates
- Excessive provider costs or infinite retries
- Unwanted outbound messages or form submissions
- Copyright, platform terms, and data retention violations

## Controls
Treat source content as data; validate schemas and evidence IDs; strict domain/IP allow/deny checks; server-only secrets; RLS; privacy classes and sharing filters; cost ceilings; approval gates; rate limits; audit logs; retention controls.

## Release blockers
Any unapproved outbound action, leaked secret, unsupported claim presented as fact, private-group content publicly exposed, or unrestricted URL fetcher is a release blocker.

Full controls, test requirements and release blockers: `../security/SECURITY_PROTOCOL.md`.
