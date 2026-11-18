# Secure-by-default development pipeline
Security guidance is not a guarantee; implementation must demonstrate controls with automated tests and independent review.

## Mandatory checks before live mode
Typecheck, lint, unit tests, integration tests, dependency audit, secret scan, schema/migration validation, Supabase RLS negative tests, authz/IDOR tests, SSRF tests, prompt injection tests, HTML sanitization/XSS tests, owner-preview restricted-content leak tests, and cost-limit tests. Record tool versions and actual results.

## CI/CD safeguards
Use least-privilege CI tokens; pin GitHub Actions to reviewed commit SHAs; protect main branch; do not expose secrets to pull requests or logs. Require review for changes to security, source adapters, database policies, and outreach. Environments separated; manual approval for production deployment and migrations. Automated dependency update PRs need tests. Generate dependency inventory/SBOM when feasible.

## Critical attack paths
- Business website redirects crawler to cloud metadata endpoint: block every redirect and resolved IP; constrain egress.
- Website HTML instructs model to reveal keys: treat as untrusted data; tool permissions deny.
- Malicious company name rendered in UI: encode output; sanitize markdown/HTML.
- Supabase client queries another user's report: RLS denies.
- Owner preview includes private Facebook-group note: redaction fails closed.
- Report link leaked: reports private by default; no share tokens in MVP.
- Agent pushes production deployment or sends email without authorization: hard approval gate.

## Security handoff
For every feature, add threat assumptions, controls, negative tests and evidence. 'Security implemented' without test output is not acceptable. No guarantee of zero breaches; reduce attack surface by keeping MVP single-operator, private and mock-first.
