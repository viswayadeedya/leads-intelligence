# Acceptance Tests and Test Matrix

## Phase 0: Foundation
- App starts in mock mode without external keys.
- Seed data explicitly marked `synthetic` and `mock` in UI/API.
- CI/typecheck/lint/unit tests run with documented commands.

## Phase 1: End-to-end vertical slice
- Manual company entry → mock investigation → evidence → opportunity → report → outreach draft.
- No automatic sending, posting, form submissions, or calls.
- Run status, cost and source failures visible.

## Evidence integrity adversarial tests
1. Wrong-business Reddit comment cannot support opportunity for target business.
2. Source returns 403: status restricted; no 'no complaints found' conclusion.
3. Booking page inaccessible: do not assert 'no booking available'.
4. Website lacks visible form on home page but has contact form: correct finding after deeper check.
5. LLM outputs invented statistic: reject or strip and log.
6. LLM cites nonexistent evidence ID: reject.
7. One angry review: label anecdotal, do not claim systemic problem.
8. Old evidence: show date and prevent 'currently' wording.
9. Search query without location: mark geo uncertainty.
10. Prompt injection in page says 'ignore instructions': treated as inert source text.

## Functional tests
- Duplicate companies merge or flag review rather than silently collide.
- Run retry idempotency; no duplicate billing or duplicate evidence.
- Per-run cost/request cap enforced.
- Manual evidence requires provenance and privacy classification.
- Owner report hides restricted/private evidence.
- Draft cannot move to approved without explicit operator action.
- SSRF protection blocks private IP/localhost targets.

## Human validation
Operator audits 20 real runs, records unsupported-claim count, useful-opportunity rate, research minutes, and cost. Compare against manual baseline. Do not claim market validation from mock fixtures.
