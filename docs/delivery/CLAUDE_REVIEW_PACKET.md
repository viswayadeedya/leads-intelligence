# Reviewer packet — no user as messenger
Claude maintains this file after every milestone. Include:
- Commit hash and changed files.
- What genuinely works vs mocked vs planned.
- Commands run and full test results; screenshot paths.
- One sample report with evidence IDs and redacted owner preview.
- Source adapter coverage, rights restrictions and cost.
- Security negative tests and unresolved vulnerabilities.
- Open product assumptions and one recommended next action.

A reviewer can inspect repository and packet directly when provided access; do not claim automatic communication between separate assistants. User only needs to share repository/archive once for independent audit.

---

# Live-evidence prototype, branch `feature/live-evidence-prototype` — 2026-11-18

**Read this first.** It sits on top of the hardening branch (next section), which is now published as `origin/review/milestone-1-hardening` at `4801fe5`. This branch is local only. Verdict requested: PASS / CONDITIONAL / FAIL. The builder does not certify security or results.

## L1. Commits
- `git log --oneline review/milestone-1-hardening..feature/live-evidence-prototype` lists them. Diff: `git diff review/milestone-1-hardening...feature/live-evidence-prototype`.
- Not pushed. Nothing merged or deployed. `main` untouched. `AGENTS.md` untouched and untracked.
- New: `scripts/live-investigate.mjs`; `tools/live-test/{approvals,run,report,investigate.live}.ts`, `vitest.live.config.mts`; `tests/live-approved-hosts.test.ts`.
- Changed: `src/lib/security/safe-fetch.ts`; `src/lib/services/investigations.ts`; `src/lib/sources/{html-extract,website-evidence,transport,robots}.ts`; `src/lib/{identity,types,config}.ts`; `src/lib/services/reports.ts`; `src/components/ui.tsx`; `src/app/settings/page.tsx`; four existing test files; delivery documents.

## L2. What is real, what is still mock, what is not in the repository
| | |
|---|---|
| Real | Three HVAC business websites were requested over the network by the approved-host transport, with the operator's approval of each exact hostname. 11 pages read. 14 observations recorded. All checked by hand against the live pages. |
| Still mock | The web app (unchanged: mock-only). The reasoner (rule set, no LLM). |
| Not in this repository, on purpose | The businesses' names and hostnames, the approvals file, the three internal reports and the verification table. They are in `research-private/live-test/` (git-ignored). A reviewer needs the owner to share that folder to check the findings themselves. |
| Not done | Operator review of the observations; display of live data in the app; retention policy; network-level egress control. |

## L3. Result in one table
| | A | B | C |
|---|---|---|---|
| Pages read | 3 | 3 | 5 |
| Identity | confirmed from site text | confirmed from site text | confirmed from site text |
| Observations | 5 | 4 | 5 |
| Verified by hand | 5 | 4 | 3, plus 1 incomplete |
| False positives | 0 | 0 | **1** ("no emergency or after-hours statement"; the page has one) |
| Opportunities proposed by the tool | 0 | 0 | 0 |
| Evidence-supported question for the owner (builder's view) | yes, weak | yes, weak | yes, moderate |

"A report with no defensible opportunity" is what all three are. Whether a grounded question is commercially enough is not something this test can answer.

## L4. Security: what a reviewer should try to break
| Claim | Where it is tested |
|---|---|
| A live request is possible only through `scripts/live-investigate.mjs` with an approvals file, a label and `--confirm-live` | `tests/live-approved-hosts.test.ts`, "the launcher and entry point refuse by default" |
| Only exact approved hostnames are reachable: not subdomains, look-alikes, redirect targets or other approved businesses | same file, "approved-host transport against controlled servers" and the end-to-end block |
| The socket layer refuses non-public addresses, odd ports and unapproved hosts even when called directly | `tests/ssrf.test.ts`, "the socket layer itself refuses..." |
| No environment variable enables any of this; nothing in `src/` or `scripts/` constructs the transport | last tests in both live test files |
| robots.txt is obeyed on every origin the run touches | "before following a redirect to another approved origin..." and the pipeline tests |
| No form is ever submitted; nothing is reviewed or approved on the operator's behalf | end-to-end test (asserts no non-GET request, all evidence `needs_review`, no approvals in the audit trail) |
| The approvals file and the output cannot be committed by accident | launcher refuses a path git would track |

### Residual risks specific to this branch
1. **Egress is restricted only inside the process.** The owner accepted this for three supervised runs. A bug in all three checks, or a compromised dependency in the same process, is not contained by anything outside it.
2. The launcher runs the investigation under the test runner because it is the project's only TypeScript runner. It works; it is not a design anyone should keep.
3. The approvals file is a JSON file the operator (or, here, the builder on the operator's stated answers) writes. Nothing signs it. Its protection is that it must exist, be fresh, be outside git, and be named on the command line.
4. One plain-HTTP redirect hop was followed for A with the owner's permission. A network attacker could alter that hop; the final page was TLS-verified and on an approved hostname.
5. Real page excerpts are now stored locally and are still not screened for personal data. One excerpt contains a business email address that the site itself publishes.
6. The extractor and verifier were adjusted after seeing three sites. 1 of 14 observations was false. No precision figure should be quoted from this.

## L5. Recommended next action
Owner: read the private verification file against the three live sites and reject the one false observation. Then decide whether to merge `review/milestone-1-hardening` and this branch. Reviewer: section L4.

---

# Review branch `review/milestone-1-hardening` — 2026-11-18

**Read this section first; it supersedes parts of "Milestone 1" below where they conflict.** Verdict requested: PASS / CONDITIONAL / FAIL on this branch before it is merged. The builder does not certify security or results.

## R1. Commit and changed files
- **Branch:** `review/milestone-1-hardening`, one commit (`4801fe5`) on top of `main` (`22068db`). Published on 2026-11-18 at the owner's request as `origin/review/milestone-1-hardening`. Not merged. Nothing deployed.
- **Diff to review:** `git diff main...review/milestone-1-hardening`.
- A remote (`origin`) exists and `main` is published there. That was done by the owner, not by the builder. The untracked file `AGENTS.md` was not created by the builder and is not in this commit.
- New: `src/lib/security/passphrase.ts`; `tests/{owner-view-audit,semantic-claims,live-fetch-controlled,auth-hardening}.test.ts`; `tests/lab/controlled-net.ts`; `scripts/{gitleaks-scan,auth-reset}.mjs`; `.gitleaks.toml`; `.gitleaksignore`; `.githooks/pre-commit`; four screenshots; `docs/delivery/test-evidence/owner-view-audit-BEFORE-fix.txt`.
- Changed: `src/lib/{auth,config,runtime,types}.ts`; `src/lib/security/{safe-fetch,origin}.ts`; `src/lib/reasoning/verifier.ts`; `src/lib/services/{reports,analysis,outreach,investigations}.ts`; `src/lib/sources/website-evidence.ts`; `src/proxy.ts`; `src/app/{actions.ts,login/page.tsx,settings/page.tsx,reports/[id]/page.tsx}`; scripts, `.gitignore`, `.env.example`, `package.json`; existing tests adjusted where behaviour changed on purpose; delivery and UX documents; regenerated sample reports.

## R2. What the review found and what changed
| # | Question asked | Answer | Evidence |
|---|---|---|---|
| 1 | Does `buildOwnerView` leak private information through `run.unknowns` (question and reason)? | **Yes.** Both fields were copied verbatim into the owner view and the export. In existing code paths the text that leaked was internal fetch diagnostics; a planted restricted note leaked verbatim. Fixed: owner wording is rebuilt from structured fields; free text is never printed. | `tests/owner-view-audit.test.ts` (first describe); failing run on the old code in `test-evidence/owner-view-audit-BEFORE-fix.txt` |
| 2 | What else reaches an owner that should not? | Access-detail text, raw excerpts, the operator's decision note, review-state wording, internal IDs, and (most serious) restricted text paraphrased by the reasoner into a claim that cites only public evidence. All fixed; the owner view is now an allowlist type. | Taint-sweep tests plant a marker in every internal free-text field (more than 40 fields per case) for seven golden cases and require none to come out |
| 3 | Do claims survive adversarial paraphrase? | Many did. The verifier was a short keyword list. It now has about twenty rule families; about 80 paraphrased overclaims are rejected. **Seven kinds still get through and are listed as tests.** | `tests/semantic-claims.test.ts` parts 1 and 2 |
| 4 | Is human approval still mandatory? | Yes, and it is now tested as a chain: four separate human actions before anything is exportable; non-human actors refused at every step; reasoner output cannot approve itself; rewording withdraws approval. | `tests/semantic-claims.test.ts` part 3 |
| 5 | Does the live fetcher hold up against real servers? | It had seven defects (listed in BUILD_LOG section 3), two of which would have produced false "not found" observations and one of which could attribute another site's content to the business. Fixed. | `tests/live-fetch-controlled.test.ts`, 111 tests, real sockets, loopback only |
| 6 | Is general live research enabled? | **No.** A second lock was added and is tested. | Last describe in the same file |
| 7 | Operator authentication | One-click sign-in removed; setup code + hashed passphrase; global lockout (the old limiter could be reset by changing a header); idle timeout; host-name check against DNS rebinding. | `tests/auth-hardening.test.ts`, 55 tests; browser check in BUILD_LOG |
| 8 | Established secret scanner | gitleaks 8.30.1 in `npm run verify`. Published history: only three known canary strings. | `scripts/gitleaks-scan.mjs`, `.gitleaks.toml`, `.gitleaksignore` |

## R3. Commands and results
```
npm install
npm run verify      # exit 0; needs gitleaks >= 8.25 on PATH (Windows: winget install --id Gitleaks.Gitleaks -e)
```
| Check | Result |
|---|---|
| typecheck | pass |
| lint | 74 files, 0 errors, 0 warnings |
| tests | 13 files, 461 passed, 0 failed, 0 skipped |
| gitleaks, git history (all branches) | 0 findings (3 canaries recorded in `.gitleaksignore`) |
| gitleaks, working folder | 0 findings |
| project-rule scan | 0 findings |
| client bundle canary check | 0 findings in 14 files |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (dev tools) | unchanged: 16 high, all the picomatch advisory in test/lint tooling |

Output: `docs/delivery/test-evidence/verify-output.txt`. Every test by name: `vitest-verbose.txt`. Screenshots 14 to 17: `docs/ux/screenshots/`.

To reproduce the leak on the old code: check out `main` in a second worktree, copy `tests/owner-view-audit.test.ts` from this branch into it, and run that file. 21 of 24 tests fail there.

## R4. Sample report
`docs/examples/SAMPLE_MOCK_REPORT_OWNER.md` and `SAMPLE_MOCK_REPORT_INTERNAL.json` were regenerated. The owner version now lists each source as address, fixed status word and time, and names the kind of source under each observation. Still synthetic.

## R5. Source adapter coverage (website adapter)
| Case from `SOURCE_IMPLEMENTATION_CONTRACTS.md` | Mock fixtures | Controlled servers (real sockets) |
|---|---|---|
| success | yes | yes |
| empty | no fixture | yes (empty body, empty site) |
| restricted (401/403/407/451, robots, challenge) | yes | yes |
| rate limit (429) | no | yes (fetcher level; reported restricted, not retried) |
| timeout, and retry | yes | yes |
| wrong business | yes | redirect to another site: yes |
| duplicate | yes | not applicable |
| malicious content | yes | yes |
| unexpected schema | no | yes (malformed HTTP, wrong type, wrong encoding) |
| budget exhaustion | yes | yes |

**"Live tested" does not apply to anything.** The controlled servers are on this machine. No real third-party site has been requested.

## R6. Security negative tests: what changed since Milestone 1
| # | Requirement | Change |
|---|---|---|
| 1 | Anonymous cannot read | Sessions now require a credential. Forged cookie: API 401; page streams a shell then redirects (HTTP 200, no protected content; see BUILD_LOG "surprises" 5). |
| 3 | Secrets not in bundle, logs, repo | gitleaks now runs on history and working folder. |
| 4 | Fetch rejects internal targets, redirects, rebinding, oversized | Now also exercised with real sockets against controlled servers, with a canary that must never be reached. **Still no egress network restriction.** |
| 5 | Injected instructions cannot trigger action | Also run through the real fetch path. Still no real model. |
| 7 | Restricted notes absent from exports | The earlier pass was incomplete: it did not cover unknowns or reasoner-written text. Both are now covered. |
| 8 | Unapproved outbound action fails | Unchanged; chain test added. |
| 9 | Malicious HTML escaped | Claims containing markup are now also rejected by the verifier. |
| 11 | CSRF | Host-name check added in front of the origin check. |
| 12 | CI | **Still not met: there is no CI.** |

### Unresolved vulnerabilities and residual risks (replaces the Milestone 1 list)
1. No second factor. Single passphrase; lockout is global, so a local attacker can lock sign-in for 15 minutes at a time (sessions already open keep working).
2. The data file is plain JSON. It now also holds the passphrase hash. Any program running as the same operating-system user can read it and the setup code file.
3. `OPERATOR_PASSPHRASE`, if used, is plain text in the environment.
4. No egress restriction, no per-IP rate limiting, no retention or deletion, no CI.
5. The verifier cannot judge meaning. Seven known kinds of overclaim pass it. Human review is the control that matters.
6. Two-context reasoning has never been run with an LLM, and a public-only claim can omit a contradicting restricted observation.
7. The fetcher has a test seam (`dial`, `ca`) in production code. A test fails the build if application code uses it; it is still code that exists.
8. Excerpts are still not screened for personal data. They no longer reach the owner view, but they are stored and shown internally.
9. RLS policies remain an unapplied SQL file. Dev-tooling advisories remain unfixed.
10. The commit already published on `origin/main` contains the one-click sign-in code and the unfixed owner view. It is mock-only code with no real data, but anyone running `main` gets those weaknesses until this branch is merged.

## R7. Open product assumptions (additions)
- That an operator will read the redaction summary before approving the owner text. It now carries two more numbers.
- That the stricter verifier does not reject too many honest claims from a real model. Unknown until one is connected; every rejection is logged with its code so this can be measured.
- That first-run setup (open a file, paste a code) is acceptable friction. It adds a step to "start a mock investigation in under 60 seconds".

## R8. One recommended next action
Review and merge this branch before anyone else runs `main`. Then decide the third-party comment policy; that is now the only open item that affects what an owner could be shown.

---

# Milestone 1 — Phase 0 + Phase 1 (mock vertical slice) — 2026-11-18

**Verdict requested from reviewer:** PASS / CONDITIONAL / FAIL per `REVIEWER_CHECKLIST.md`. The builder does not certify security or results. Everything below is evidence to check, with paths.

## 1. Commit hash and changed files
- **Commit: the root commit of `main`** (print the hash with `git rev-list --max-parents=0 HEAD`; a commit cannot contain its own hash). The repository was initialised locally on 2026-11-18 at the owner's request. When this was written no remote existed; the owner has since published `main`. The whole milestone is one commit, so there is no incremental diff to review; review the tree.
- **Pre-commit sensitive-data review:** see the second 2026-11-18 entry in `BUILD_LOG.md`. One finding (the local project path, containing an OS account name, in two captured test-output files) was fixed before committing. No established secret scanner had been run at that point. gitleaks has since been run over this commit: three findings, all canary strings (see "Review branch" above).
- Changed files: full list in `BUILD_LOG.md` (2026-11-18 entry). Pre-existing files edited: `README.md`, `.gitignore`, `.env.example`, `docs/delivery/{BUILD_LOG,DECISIONS,CLAUDE_REVIEW_PACKET}.md`, `docs/security/SECURITY_REVIEW_CHECKLIST.md` (evidence appended, original text untouched). No other specification document was changed.

## 2. What genuinely works, what is mocked, what is planned
**Works (real code, exercised by tests and in a browser):**
- Sign-in with server-side sessions; every page, action and API route re-checks the session.
- Business entry with validation, duplicate flagging (never silent merge), identity check against the site's own text, operator override with audit entry.
- Investigation state machine: robots.txt honored, bounded page plan, per-run request and cost caps, bounded idempotent retry, stop, failure never reported as clean.
- HTML extraction from untrusted pages (parsed, never executed; hidden nodes, scripts and comments ignored).
- Evidence rules: scoped presence/absence observations; absence only after complete collection; otherwise an explicit unknown.
- Claim verifier and evidence desk (accept / reject / needs verification, contradiction flagging, manual observations with mandatory provenance and privacy class).
- Report: seven sections, claim-level sources, internal watermark, content-hash-bound approval that is withdrawn automatically if evidence changes.
- Owner-safe view and Markdown export that fail closed.
- Outreach draft from one accepted, owner-safe finding; language rules; exact-text approval; copy-only.
- Append-only audit trail.

**Mocked (clearly labelled MOCK in UI, API and exports):**
- Website content: 15 fictional fixtures (`src/fixtures/golden.ts`), `.invalid` domains, 555-01xx numbers. **No real website was fetched.**
- Reasoner: deterministic rules (`mock-rules-v1`). **No LLM was called.**
- "Public signals": only notes typed by the operator, or fictional fixture notes.

**Built but not enabled and not live-tested:** guarded HTTP fetcher with DNS pinning (`src/lib/security/safe-fetch.ts`).

**Written but not applied or tested:** `supabase/migrations/0001_init.sql` (schema + RLS policies).

**Planned, not built:** Places discovery, search/AI-search sampling, review APIs, Outcomes tracking, global search, batch select, retention/delete/export, most proposed REST endpoints, CI.

## 3. Commands and results
Run from the repository root (Node 24.22.1, npm 12.2.1):
```
npm install
npm run verify      # exit 0
```
| Check | Result |
|---|---|
| typecheck | pass |
| lint | 0 errors, 0 warnings |
| tests | 9 files, 176 passed, 0 failed |
| secret scan (stopgap script) | 0 findings |
| client bundle canary check | 0 findings in 14 browser files |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (with dev tools) | 16 high, all the picomatch ReDoS advisory in test/lint tooling |

- Full output: `docs/delivery/test-evidence/verify-output.txt`
- Every test by name: `docs/delivery/test-evidence/vitest-verbose.txt`
- Screenshots (13, synthetic data): `docs/ux/screenshots/`, indexed in `docs/ux/WALKTHROUGH.md`
- To reproduce the walkthrough: `npm run dev`, open http://127.0.0.1:3210, follow `docs/ux/WALKTHROUGH.md`.

## 4. Sample report
- Internal view with full evidence IDs: `docs/examples/SAMPLE_MOCK_REPORT_INTERNAL.json` (2 opportunities; the second cites a restricted private-group note).
- Redacted owner version: `docs/examples/SAMPLE_MOCK_REPORT_OWNER.md` (1 finding; the restricted note and the finding depending on it are absent; every evidence line carries a short evidence ID and source URL).
- Regenerate: `WRITE_SAMPLE=1 npx vitest run tests/sample-report.test.ts` (PowerShell: `$env:WRITE_SAMPLE='1'; npx vitest run tests/sample-report.test.ts`). IDs are regenerated each time.
- Both are **synthetic**. They show the format, not a real finding.

## 5. Source adapter coverage, rights and cost
| Source | State | Rights / restrictions handled | Cost |
|---|---|---|---|
| Business website, mock fixtures | Working | robots.txt (allow/disallow/wildcards/agent groups; 5xx on robots = no access assumed), 401/403/429 = restricted and never retried, same-site pages only, max 5 pages, no form submission of any kind | 0 |
| Business website, live | Fetcher built, **off, not live-tested** | as above plus SSRF guard, redirect re-validation, byte/time/content-type limits, CAPTCHA stop, off-domain redirect = restricted | not measured |
| Manual observations | Working | provenance required, privacy class required, gated sources forced to restricted, emails/usernames refused, never auto-collected | operator time, not measured |
| Google Places, search, AI search, Yelp, Reddit/Facebook APIs | Not built | — | — |

Per-adapter acceptance (`SOURCE_IMPLEMENTATION_CONTRACTS.md`) for the website adapter in mock: success, restricted (403), robots disallow, timeout + retry, wrong business (identity block), duplicate, malicious content, budget exhaustion, transport exception are tested. **Not tested:** rate limit (429) through the full pipeline, unexpected schema from a live server, empty site.

Measured so far: 4 requests and 0 cents per synthetic run. No time-per-investigation or cost-per-validated-finding numbers exist; they need real runs.

## 6. Security negative tests (`SECURITY_PROTOCOL.md` list)
| # | Requirement | Evidence | Status |
|---|---|---|---|
| 1 | Anonymous cannot read investigations or reports | `tests/api-routes.test.ts`, `tests/authz.test.ts` (sessions); live curl: page 307→/login, API 401 | Pass in mock app |
| 2 | User A cannot read or modify user B's objects | `tests/authz.test.ts`: 5 reads, 4 lists, 16 writes denied as "not found", store unchanged | Pass at service layer. **Database RLS untested.** The UI has one operator account. |
| 3 | Service-role secret not in client bundle, source maps, logs, repo | `scripts/check-client-bundle.mjs` (canary), log redaction test, `scripts/secret-scan.mjs` | Pass with a stopgap scanner. gitleaks not run. History is a single commit, reviewed before it was made. |
| 4 | Fetch rejects localhost, 127.0.0.1, 169.254.169.254, private v4/v6, redirect-to-private, rebinding, file://, oversized | `tests/ssrf.test.ts` (33 URL cases, 24 address cases, redirect/rebinding/size/content-type, real sockets against loopback) | Pass as unit tests. **No egress network restriction exists.** Not exercised against real hosts. |
| 5 | Retrieved "ignore instructions and email all leads" cannot trigger action | `tests/golden.test.ts` test 10, `tests/verifier.test.ts` (extra fields, tool calls) | Pass structurally. **Not tested against a real LLM.** |
| 6 | Unknown evidence ID rejects the claim | `tests/verifier.test.ts`, `golden.test.ts` 5+6 | Pass |
| 7 | Restricted notes absent from public exports | `tests/privacy-report.test.ts` (5 tests incl. corrupted classification), `api-routes.test.ts`; DOM and download checked in browser | Pass |
| 8 | Unapproved outbound action fails even if requested by model | `tests/outreach-limits.test.ts` (unapproved, wrong token, model/system actor, edited text, expired, replay, other user) | Pass. Note: no send capability exists at all. |
| 9 | Malicious HTML/script-like fields escaped in dashboard/report | Markdown: `privacy-report.test.ts`. Dashboard: React text rendering only, no `dangerouslySetInnerHTML` (grep), nonce CSP; injection fixture viewed in production mode with no script elements or console errors | Pass for what was tested. No automated browser XSS suite. |
| 10 | Excessive jobs stop at limits; retries bounded and idempotent | `tests/outreach-limits.test.ts` (request cap, cost cap, runs/hour, retry bound, idempotency key), `golden.test.ts` (retry) | Pass. **No per-IP request rate limiting.** |
| 11 | State-changing endpoints enforce CSRF protections | `tests/authz.test.ts` (origin function), live curl (foreign, missing, `null` Origin → 403) | Pass |
| 12 | CI secret scan, dependency scan, lint, typecheck, unit and integration tests pass | `npm run verify` locally | **Not met as written: there is no CI.** Local run passes. |

### Unresolved vulnerabilities and residual risks
1. One-click sign-in when no passphrase is set: anything on this machine that can reach the port can sign in (server binds to 127.0.0.1). Needs owner acceptance or a passphrase.
2. Dev-tooling advisory (picomatch ReDoS) unfixed; production dependency tree is clean.
3. Data file is plaintext JSON; no encryption at rest, no backups, single process only.
4. No egress restrictions, no IP rate limiting, no retention/deletion, no incident tooling beyond the runbook text.
5. Verifier keyword rules are evadable by paraphrase; identity matching is simple text matching and can both over- and under-flag.
6. Excerpts are bounded but not screened for personal data (matters once real pages are fetched).
7. Passphrase compared as a plain environment value; no MFA; `Secure` cookie only in production mode.
8. RLS policies exist only as an unapplied SQL file.

## 7. Open product assumptions
- That an owner finds "phone listed, no online request path on N inspected pages" worth a conversation. Unproven; it is the mock reasoner's main rule and may be too generic (the kill criterion in `DIFFERENTIATION_AND_FALSIFICATION.md` applies).
- That HTML-only inspection is good enough; many booking widgets load through JavaScript, so false "not found" observations are likely on real sites. The observation says so, but the false-positive rate is unknown.
- That a single operator can review about six observations per business quickly. Not timed.
- That paraphrased public comments with links may be shown to owners (terms/legal question, owner's decision).
- Willingness to pay, reply rates, competitor offers: untouched by this milestone.

## 8. Contradictions found in the specification (recorded, resolved as noted)
| Where | Conflict | Resolution |
|---|---|---|
| `ROADMAP.md` vs `DEFINITION_OF_READY.md` | Phase 1 mock slice vs Phase 1 "live vertical slice" | Roadmap order; live stays Phase 2 (ADR-006) |
| `DATA_MODEL.md` vs aggregation | single `source_record_id` vs multi-page observations | array (ADR-012) |
| `DATA_MODEL.md` vs `SECURE_BUILD_PIPELINE.md` | `share_token_hash` vs "no share tokens in MVP" | omitted (ADR-013) |
| `SYSTEM_DESIGN.md` vs `AGENT_BOUNDARIES.md` | two run-state lists | SYSTEM_DESIGN (ADR-015) |
| `SCREEN_BLUEPRINTS.md` vs `UX_PRINCIPLES.md` | six stage statuses vs required "Not checked" | added (ADR-015) |
| `SCREEN_BLUEPRINTS.md` Discover | primary action "Find businesses" needs Places | primary is "Add business"; discovery shown as not available |
| `CLAUDE.md` | reading-order numbering repeats 5–9 | cosmetic; all listed files were read |

## 9. One recommended next action
Have the independent reviewer run section 3 and try to break section 6 rows 2, 4, 7 and 8 by hand, while the owner does the five walkthrough tasks unaided. Do not start Phase 2 (real website fetching) until that review is back and the three owner decisions in `DECISIONS.md` are made.
