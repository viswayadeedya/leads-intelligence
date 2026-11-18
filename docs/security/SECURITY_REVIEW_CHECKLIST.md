# Security Review and Evidence Log

For every PR or milestone, reviewer must record PASS / FAIL / NOT APPLICABLE with commands, screenshots (redacted), test artifacts and commit hash.

| Gate | Evidence required |
|---|---|
| Authn/authz and RLS | Negative cross-user test output |
| SSRF/egress | Redirect/DNS/private-network tests |
| Prompt injection | Malicious-source fixture cannot escalate privileges |
| Secrets | Scanner output and client bundle inspection |
| Privacy | Restricted content excluded from public report/export |
| Outbound safety | No action without exact human approval |
| Resource caps | Cost, tokens, retries, timeout enforced |
| Supply chain | Lockfile, dependency scan, CI status |
| Incident readiness | Rotation/disable instructions and on-call owner |

Any untested applicable gate is a blocker, not an assumed pass. Document residual risk in `docs/delivery/DECISIONS.md`.

---

## Builder-submitted evidence — Milestone 1 (2026-11-18). NOT A REVIEW.
Recorded by the builder (Claude) so the reviewer has something concrete to check. The reviewer must fill in the verdict column; the builder's column is a claim, not a certification. Commit hash: none (no git repository yet).

| Gate | Builder's evidence | Builder's claim | Reviewer verdict |
|---|---|---|---|
| Authn/authz and RLS | `tests/authz.test.ts`, `tests/api-routes.test.ts`; live curl probes in `docs/delivery/BUILD_LOG.md` | Application-layer owner scoping: pass. **RLS: NOT TESTED** (SQL file unapplied) | |
| SSRF/egress | `tests/ssrf.test.ts` (URL, address, redirect, rebinding, size, loopback sockets) | Unit tests pass. **Egress restriction: NOT IMPLEMENTED.** Live fetch is disabled | |
| Prompt injection | `tests/golden.test.ts` (test 10), `tests/verifier.test.ts` | Pass structurally. **No real model tested** | |
| Secrets | `npm run secret-scan`, `npm run check:bundle` | Pass with stopgap scanner. **gitleaks NOT RUN** | |
| Privacy | `tests/privacy-report.test.ts`; browser DOM and export checked | Pass | |
| Outbound safety | `tests/outreach-limits.test.ts`; no send code exists | Pass | |
| Resource caps | `tests/outreach-limits.test.ts` (request, cost, runs/hour, retries) | Pass. Token caps: NOT APPLICABLE (no model). IP rate limit: NOT IMPLEMENTED | |
| Supply chain | `package-lock.json`, exact versions, `npm audit --omit=dev` = 0 | Dev tooling has 16 high advisories (unfixed). **CI: NONE** | |
| Incident readiness | `docs/architecture/OPERATIONS_RUNBOOK.md` text only | **NOT TESTED.** No keys exist to rotate; no on-call owner named | |

Applicable gates that are untested are blockers for live mode, per the rule above. They do not block continued mock-mode use.

---

## Builder-submitted evidence — review branch `review/milestone-1-hardening` (2026-11-18). NOT A REVIEW.
Commit: the single commit on that branch after `22068db` (`git log --oneline main..review/milestone-1-hardening`). The reviewer fills in the verdict column.

| Gate | Builder's evidence | Builder's claim | Reviewer verdict |
|---|---|---|---|
| Authn/authz and RLS | `tests/auth-hardening.test.ts` (55), `tests/authz.test.ts`, `tests/api-routes.test.ts`; browser and curl probes in BUILD_LOG | No passwordless path; hashed passphrase; global lockout; idle timeout; host-name check. **No second factor. RLS: NOT TESTED** | |
| SSRF/egress | `tests/ssrf.test.ts` (73), `tests/live-fetch-controlled.test.ts` (111, real sockets, loopback only, canary never reached) | Pass against controlled servers. **Egress restriction: NOT IMPLEMENTED. No real site contacted.** Live fetch locked | |
| Prompt injection | as before, plus the hostile page through the real fetch path, plus two-context reasoning (`tests/owner-view-audit.test.ts`) | Pass structurally. **No real model tested** | |
| Secrets | `npm run secret-scan`: gitleaks 8.30.1 on history and working folder, plus project rules; `npm run check:bundle` | History: 3 canary strings, recorded with reason. Working folder: 0 | |
| Privacy | `tests/owner-view-audit.test.ts` (24), `tests/privacy-report.test.ts`; before-fix failures in `test-evidence/owner-view-audit-BEFORE-fix.txt` | The Milestone 1 "Pass" was wrong: unknowns and reasoner-written text leaked. Fixed and tested. Excerpts are still not screened for personal data (internal only) | |
| Outbound safety | `tests/semantic-claims.test.ts` part 3, `tests/outreach-limits.test.ts`; no send code exists | Pass | |
| Resource caps | as before, plus the request cap against a controlled 40-link page | Pass. IP rate limit: NOT IMPLEMENTED | |
| Supply chain | lockfile, `npm audit --omit=dev` = 0; gitleaks installed through winget with hash verification | Dev tooling advisories unfixed. **CI: NONE** | |
| Incident readiness | `npm run auth:reset`; runbook text | Passphrase reset tested by hand. Otherwise NOT TESTED | |

---

## Builder-submitted evidence — branch `feature/live-evidence-prototype` (2026-11-18). NOT A REVIEW.
First real requests made by this project: three operator-approved business websites. The reviewer fills in the verdict column.

| Gate | Builder's evidence | Builder's claim | Reviewer verdict |
|---|---|---|---|
| SSRF/egress | `tests/live-approved-hosts.test.ts`, `tests/ssrf.test.ts` (socket layer), `tests/live-fetch-controlled.test.ts`; live request logs in the private reports | Exact-hostname allowlist enforced at three points in the process. **Network-level egress restriction: NOT IMPLEMENTED; accepted by the owner for this supervised test only (ADR-025)** | |
| Access restrictions | robots.txt per origin (tests); live logs show GET only | No page was refused, no bot check appeared, no form was submitted. Two redirects were refused until the owner approved the target | |
| Privacy | Launcher refuses tracked paths; `.gitignore`; ADR-026 | No real business is named in the repository. Page excerpts are stored locally, unscreened | |
| Evidence integrity | Manual check of 14 observations against the live pages (private verification file) | 12 verified, 1 incomplete, **1 false "not found"**; rule fixed with a regression test | |
| Outbound safety | End-to-end test: nothing reviewed, approved, drafted or sent | Pass. All observations remain `needs_review` | |
| Retention | Live data sits in one ignored folder | **NOT DEFINED.** Delete the folder by hand | |
