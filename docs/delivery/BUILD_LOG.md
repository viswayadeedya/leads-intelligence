# Build Log

Status: **Phase 0 and Phase 1 (roadmap numbering) built in mock mode. Live mode is not available. Awaiting independent review; nothing here is self-certified.** `main` is commit `22068db` and has since been published to a remote by the owner. The hardening branch is published as `origin/review/milestone-1-hardening` (`4801fe5`). The first live test (three real websites, operator-approved) is on the local branch `feature/live-evidence-prototype`; see the last entry.

## Initial handoff
- Documents and synthetic fixture prepared.
- No live API calls, no business research, and no app code implemented.
- Next action: Claude reads `CLAUDE.md` and `docs/INDEX.md`, implements Phase 0.

## Entry template
Date / phase / files changed / commands run / tests passed or failed / evidence / blockers / next exact step.

---

## 2026-11-18 — Phase 0 (Foundation) and Phase 1 (Trustworthy vertical slice, mock)

**Builder:** Claude (one session). **Environment:** Windows 11, Node 24.22.1, npm 12.2.1, TypeScript 6.0.3, Next.js 16.4.6, React 19.3.1, Vitest 5.1.1, ESLint 9.39.5. **Version control:** the folder is not a git repository; nothing was committed.

### What was built
Manual business entry (or a synthetic example) → identity check against the site → website collection through a transport interface (mock fixtures) honoring robots.txt and budgets → scoped observations → rule-based reasoner → claim verifier → evidence desk review → report (internal and owner-safe) → explicit approvals → editable outreach draft (copy-only). All eight navigation destinations exist; Outcomes is an honest "not built" page.

### Files (all new unless noted)
- Config: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.mts`, `.claude/launch.json`; edited `.gitignore`, `.env.example`, `README.md`.
- Library: `src/lib/{types,config,errors,ids,store,context,log,identity,auth,runtime}.ts`; `src/lib/security/{net-guard,safe-fetch,origin}.ts`; `src/lib/sources/{transport,mock-transport,html-extract,robots,website-evidence}.ts`; `src/lib/reasoning/{reasoner,verifier}.ts`; `src/lib/services/{businesses,investigations,analysis,evidence,reports,outreach,overview}.ts`.
- Fixtures: `src/fixtures/golden.ts` (15 fictional cases).
- App: `src/proxy.ts`; `src/app/{layout,page,loading,error,not-found}.tsx`, `src/app/actions.ts`, `src/app/globals.css`; pages under `src/app/{login,discover,investigations,evidence,reports,outreach,outcomes,settings}`; API routes `src/app/api/investigations/[id]/route.ts`, `src/app/api/reports/[id]/export/route.ts`; `src/components/{ui,CopyButton}.tsx`.
- Tests: `tests/{helpers,ssrf.test,golden.test,verifier.test,authz.test,privacy-report.test,outreach-limits.test,extract-robots.test,api-routes.test,sample-report.test}.ts`.
- Scripts: `scripts/{run-next,secret-scan,check-client-bundle}.mjs`.
- Database: `supabase/migrations/0001_init.sql` (**not applied, not tested**).
- Docs: this file, `DECISIONS.md` (ADR-005 to ADR-016), `CLAUDE_REVIEW_PACKET.md`, `docs/ux/WALKTHROUGH.md`, `docs/ux/screenshots/*.jpg` (13), `docs/examples/SAMPLE_MOCK_REPORT_{INTERNAL.json,OWNER.md}`, `docs/delivery/test-evidence/{verify-output,vitest-verbose}.txt`, builder evidence appended to `docs/security/SECURITY_REVIEW_CHECKLIST.md`.
- Size: about 7,200 lines in `src/`, 1,700 in `tests/`.

### Commands run and results (final run, after the last code change)
| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `npm run lint` (`eslint .`) | exit 0; 66 files, 0 errors, 0 warnings |
| `npm test` (`vitest run`) | 9 files, **176 passed, 0 failed** |
| `npm run secret-scan` | 0 findings (stopgap scanner; gitleaks **not** run). Scanner confirmed to fail when two fake secrets were planted. |
| `npm run check:bundle` | builds with canary secrets; 14 browser files (603,655 bytes), 0 canary values, 0 server-only variable names, 0 source maps |
| `npm run audit` (`npm audit --omit=dev`) | 0 vulnerabilities in production dependencies |
| `npm audit` (including dev tools) | **16 high** (picomatch ReDoS in vitest/eslint toolchain). Not fixed; see DECISIONS. |
| `npm run build` | success; 15 routes, all dynamic |
| `npm run verify` | exit 0. Full output: `docs/delivery/test-evidence/verify-output.txt`; per-test list: `vitest-verbose.txt` |

Live probes against the running dev server: anonymous page request → `307 /login`; anonymous API → `401`; POST with foreign Origin, no Origin, or `Origin: null` → `403`; export as owner → `200 text/markdown` without the restricted marker; export anonymous → `401`; session cookie not readable from page script.

### Failures hit along the way (and what was done)
1. First test run: 5 of 171 failed. Two were real defects: log redaction did not match keys like `SUPABASE_SERVICE_ROLE_KEY` (fixed: any key containing `key`, `credential`, etc.), and `)` was not percent-encoded in exported URLs (fixed). Three were wrong test assumptions (a seeded fixture note also creates a source record and an observation).
2. Browser walkthrough: a form posted before JavaScript loaded was refused with raw JSON 403. Cause: `Referrer-Policy: no-referrer` produces `Origin: null` on plain form posts. Fixed by using `same-origin` and a readable refusal page; re-tested in the browser and with curl.
3. Browser walkthrough: horizontal overflow at 375px width. Fixed and re-measured on six pages.
4. Walkthrough findings fixed: audit trail credited system events to the human; a journey row misdescribed a rejected observation; review needed an extra click per item; examples were hard to find. See `docs/ux/WALKTHROUGH.md`.
5. A one-off patch script failed twice on shell quoting; the edits were applied directly instead. No effect on the code.

### Phase gate status (builder's evidence; reviewer decides)
- **Phase 0 gate — "app starts without keys; typecheck/tests pass":** evidence above. Met, in the builder's view.
- **Phase 1 gate — "complete flow demonstrated with synthetic data; evidence adversarial tests pass":** flow walked in a browser with synthetic data (13 screenshots); acceptance tests 1–10 and the functional tests are automated in `tests/golden.test.ts`, `verifier.test.ts`, `outreach-limits.test.ts`, `privacy-report.test.ts`. Met, in the builder's view.
- **Security "Local mock" release gate:** secrets scanning (stopgap tool only), auth boundaries, SSRF unit tests, injection tests, no outbound side effects: evidence exists for each. **Not independently reviewed.**
- **Human validation (20 real runs) and the usability test with the operator:** not done; cannot be done by the builder.

### Not done / not verified
- No real website was fetched. The live fetcher is unit-tested only (injected DNS, loopback server).
- No LLM was called. No Supabase or Postgres was used; RLS is unverified.
- gitleaks not run; no CI; no git history.
- Outcomes screen, Places discovery, global search, batch select, retention/delete/export, and most of the proposed REST endpoints are not built.
- Accessibility not audited.
- UI behavior is covered by the manual browser walkthrough only; there are no automated browser (end-to-end) tests. The 176 automated tests exercise the library, services and API route handlers.
- 12 of 13 screenshots predate the walkthrough fixes.

### Blockers (need the owner)
1. Approval to initialise git and commit (required for a commit hash in the review packet and for history-based secret scanning).
2. Approval and site choices for Phase 2 live website fetching, after the live-mode gates.
3. Policy on reusing third-party public comments in owner reports (legal/terms question).
4. Whether to install gitleaks (a downloaded binary) or keep the stopgap scanner.

### Exact next step
Independent reviewer runs `npm install && npm run verify`, then `npm run dev`, and works through `docs/delivery/REVIEWER_CHECKLIST.md` using `CLAUDE_REVIEW_PACKET.md`. In parallel the owner does the five tasks in `docs/ux/WALKTHROUGH.md` unaided and records where they hesitate. After review: Phase 2, starting with egress restriction design and RLS tests against a development database, before any real site is fetched.

---

## 2026-11-18 — Version control: repository initialised, first commit prepared

**Requested by the owner.** No remote was added, nothing was pushed, no hosting repository was created.

### Files changed
- New: `.gitattributes` (line-ending normalisation; images marked binary).
- Rewritten: `.gitignore` (environment files except `.env.example`; keys and credential files; cookies, session state and HAR captures; local databases including `.data/`; private research folders and exports; logs; build output; scanner reports; local editor/assistant state).
- Edited: `scripts/secret-scan.mjs` (new rule: local user-directory paths), `docs/delivery/test-evidence/*.txt` (regenerated, local path replaced with `<repo>`), this file, `DECISIONS.md` (ADR-017), `CLAUDE_REVIEW_PACKET.md`.

### Pre-commit review of what is tracked (134 files)
| Check | Method | Result |
|---|---|---|
| Ignored paths stay out | `git status --short --ignored` | `.data/`, `.next/`, `node_modules/`, `next-env.d.ts`, `tsconfig.tsbuildinfo` ignored; none staged |
| Personal identifiers | `git grep --cached` for the OS account name, home-directory paths, machine name | **2 findings, fixed:** both captured test-output files printed the absolute project path (which contains the OS account name). Replaced with `<repo>`; the scanner now fails on such paths. |
| Email addresses | `git grep --cached` | 3 distinct, all reserved/test domains (`example.com`, `example.invalid`) |
| Known key formats | `git grep --cached` (AWS, Google, GitHub, Slack, Stripe, `sk-`, JWT, private-key blocks, bearer tokens) | 0 |
| Credential-like literals | `git grep --cached` | Only deliberate fakes: canary values in `scripts/check-client-bundle.mjs`, redaction-test inputs in `tests/outreach-limits.test.ts` (`sk-live-abc`, `eyJhbGciOi`, `hunter2`), a forged-cookie string in `tests/api-routes.test.ts`. **An established scanner may flag these as false positives.** |
| `.env.example` | read in full | every secret placeholder empty |
| Hostnames | every URL host listed and read | fixture/test hosts are `*.example.invalid`, `example.com/.net/.org`, loopback and private ranges (SSRF tests). Real hosts appear only as vendor documentation links in the specification and as a detection list of scheduling providers; two test strings use `facebook.com/…` and `book.housecallpro.com/x` as link targets with placeholder paths. |
| Phone numbers | every phone-shaped string listed | all 15 are `555-01xx` (reserved for fiction) |
| Fixtures | `src/fixtures/golden.ts` read | every business name carries "(synthetic)", every domain ends `.example.invalid`, the only street address is "410 Sample Street" |
| Screenshots | all 13 opened and read; JPEG segments inspected | synthetic data only; no browser chrome, tabs, bookmarks or account names; no EXIF, GPS, XMP or comment segments |
| Sample and example reports | read | labelled mock/fictional; the restricted marker string is absent from the owner sample |

### Commands and results
| Command | Result |
|---|---|
| `gitleaks`, `trufflehog`, `detect-secrets`, `ggshield`, `git-secrets` | **none installed; no established secret scanner was run** |
| `npm run verify` | exit 0: typecheck pass; lint 0 errors/0 warnings; 9 test files, 176 passed; secret-scan (stopgap) 122 files, 0 findings; client-bundle check 14 files, 0 findings; `npm audit --omit=dev` 0 vulnerabilities |
| `node scripts/secret-scan.mjs` before sanitising | exit 1, 2 findings (the local paths), proving the new rule works |
| `node scripts/secret-scan.mjs` after the final documentation edits | 0 findings |

`npm run verify` ran before the documentation edits in this entry; only the secret scan was repeated after them (they are Markdown only).

### Commit
The root commit of `main`. Print its hash with `git rev-list --max-parents=0 HEAD` (a commit cannot contain its own hash).

### Blockers
- Blocker 1 of the previous entry (approval to initialise git) is resolved.
- Still open: independent review; Phase 2 approval and site choices; third-party comment policy; whether to install gitleaks. A history scan with gitleaks should be run **before** the first push.

### Exact next step
Unchanged from the previous entry: independent review against `REVIEWER_CHECKLIST.md`, and the owner's unaided five-task walkthrough. Before any push: install and run gitleaks over history, decide public or private hosting, and check the commit author email.

---

## 2026-11-18 — Review branch `review/milestone-1-hardening`: owner-report leak, semantic claim tests, controlled fetcher tests, sign-in, secret scanner

**Requested by the owner.** Work is on the branch `review/milestone-1-hardening`, cut from `main` at `22068db`. Nothing was pushed, nothing was deployed, `main` was not touched. Still mock-only: no real website was fetched and no LLM was called.

**State found at the start (not done by the builder):** a remote `origin` now exists and `main` is published there at `22068db`; an untracked file `AGENTS.md` (a copy of `CLAUDE.md` addressed to another assistant) is in the folder. `AGENTS.md` was left untracked and is not part of this commit. Earlier statements in this log that "no remote exists" were true when written and are no longer true.

### 1. Does `buildOwnerView` leak through `run.unknowns`? Yes.
`buildOwnerView` copied every unknown's `question` and `reason` into the owner view and the Markdown export, unfiltered. Unknowns are free text with no privacy class, so the owner report was fail-open for them.

- **What actually reached owner output in the existing code paths:** internal diagnostics, not private notes. The only writer of unknowns (`aggregateWebsiteEvidence`) builds them from website records, so the leaked text was page paths plus fetch detail: "Timed out", "Access refused (HTTP 403)", "Not fetched: robots.txt could not be read", "the request budget for this run was reached", "Blocked by the safe-fetch rules".
- **What could have reached it:** anything. A planted unknown containing the private-group marker appeared verbatim in the owner view and export (test: "an unknown written as free text never reaches the owner view or export").
- **No real data was involved.** Only synthetic fixtures have ever been run.

The audit of every owner-facing field found more. Before the fix, 21 of the 24 new audit tests failed (`docs/delivery/test-evidence/owner-view-audit-BEFORE-fix.txt`):

| Leak | Where it showed | Severity |
|---|---|---|
| `run.unknowns[].question` and `.reason` | owner view, owner preview page, Markdown export | High |
| Text written by the reasoner after it was shown restricted evidence. A claim citing only public evidence IDs carried the private-group note into the owner view and export. | owner view, preview, export, outreach draft | High (latent: the rule-based mock does not do this; an LLM could) |
| `sourceRecord.accessDetail` (free text) | owner view, preview, export | Medium |
| `evidence.supportingExcerpt` (raw page text, not screened for personal data) | owner view object and owner preview page; not in the export, so the preview did not match the export | Medium |
| `opportunity.decisionReason` (the operator's private note) | owner view object only | Medium |
| Review-state wording ("An observation for this step was not accepted in review", "Retry the failed source") | owner journey table and export | Low |
| `runId`, `mode`, full evidence and opportunity IDs, privacy class, review status | owner view object | Low |
| A website record whose URL is not on the business's domain | would have been listed with its full URL, query string included | Low (cannot occur in mock mode) |
| "Response and follow-up" journey row showed "Error" when a website page failed, though it is not read from the website | internal and owner journey | Low (accuracy) |

**Fixes**
- The owner view is now its own type (`OwnerReportView`), built field by field. Nothing is copied from the internal view. A test pins its exact keys.
- Unknowns carry structured fields (`kind`, `topic`, counts). The owner wording is rebuilt from those and from the access status of the referenced records; the stored `question` and `reason` are never printed. An unknown that is unstructured, inconsistent, or that points at a non-public record is withheld and counted in the redaction summary.
- Owner sources show only pages on the business's own domain, without query string, with a fixed status word ("Inspected", "Access restricted", "Could not be retrieved").
- Reasoning runs in two contexts. Claims that can ever reach an owner are written in a pass that is shown only public observations and can cite nothing else. A second pass (only when restricted evidence exists) sees everything and may keep only claims that cite restricted evidence; those are marked `includes_restricted` and stay internal. A claim with no recorded context is withheld.
- Export re-checks the approved text at the moment of export: the stored snapshot must hash to what was approved **and** must equal what the owner view renders now. Otherwise the share approval is withdrawn, the refusal is audited, and nothing is exported. The same check runs after every change.
- The outreach draft is built only from the owner view.
- The redaction summary now also tells the operator how many unknowns were withheld and how many included observations come from a third-party page (the open terms question in DECISIONS).

### 2. Adversarial semantic claim tests; human approval preserved
`tests/semantic-claims.test.ts` (95 tests). The verifier gained rules and paraphrase lists for: loss claims without the word "losing"; quantities without "$" or "%" (shares, multiples, "4k", "/mo", number words); patterns from one anecdote; certainty and causation; interpretations with no hedge; fixes not conditional on owner confirmation; outcome promises; comparisons with businesses nobody inspected; accusatory wording; unscoped or cross-sentence absence; a missing feature not backed by its own absence observation, or contradicted by a presence observation; behaviour inferred from a web page; an anecdote stated as fact; a complaint cited while a contrary account is left out; sources the evidence does not come from; links, domains, email addresses and usernames; old evidence worded as current or without its date; digit-for-letter swaps, spaced letters, full-width characters; invisible characters, mixed alphabets and markup (refused outright).

A real defect found while writing them: text rules could match **across two fields** of a proposal, because fields were joined without a sentence break. Fixed.

**Known gaps, asserted as tests (the verifier accepts these):** an evaluative judgment with no evidence; a consequence implied without a trigger word; urgency implied by scenario; naming a different feature than the one observed; the same overclaim in another language; a leading owner question; a slanted alternative explanation. The verifier is a keyword heuristic and cannot judge meaning.

**Human approval:** a claim that gets past the verifier is stored as pending and reaches an owner only after four separate human actions (accept each observation, accept the claim, approve the report, approve the exact owner text), each audited as human. A `model` or `system` actor is refused on every review, approval, export, investigation-start, manual-evidence and outreach step, and nothing changes. Reasoner output cannot carry `decision`, `status`, `approved`, `reasonedFrom` or any other extra field. Reworded text after approval gets a new pending decision and withdraws both approvals.

### 3. Live fetcher against controlled servers
`tests/live-fetch-controlled.test.ts` (111 tests) with `tests/lab/controlled-net.ts`. Real sockets and the real HTTP parser against HTTP, raw-TCP and TLS servers on 127.0.0.1. Test hostnames resolve through the lab's resolver to public-looking addresses; a test seam in the fetcher (`createPinnedRequest({ dial })`) translates those addresses to the local servers. Any connection to an address that is not a registered test site lands on a "canary" standing in for an internal service; every test asserts it was never reached. **No request left this machine. No real site was contacted.**

Covered: same-site, chained, looping, off-site and oversized-body redirects; redirects to 28 internal, encoded, credentialed or non-HTTP targets (one socket opened, never a second); DNS rebinding within a request and between redirect hops; 15 kinds of private or mixed DNS answers (zero sockets); DNS failures; 11 malformed or truncated responses; compressed, UTF-16, binary, invalid UTF-8 and unknown-charset bodies; empty pages; wrong content types; odd status codes; four timeout shapes including a drip-fed body; declared, endless and exactly-at-limit sizes; refused connections; 401/403/407/451/429/404/410/5xx; a bot challenge; request headers (GET only, no cookies); TLS with an untrusted certificate, a wrong-hostname certificate, and an HTTPS-to-HTTP downgrade. The TLS tests need OpenSSL to make a throwaway certificate and are skipped without it; they ran here (OpenSSL 3.5.6). Then the whole investigation pipeline over the fetcher against a controlled site: healthy site, timeout then successful retry, home page redirecting elsewhere, inner page redirecting to the metadata address, robots.txt disallow and unreadable robots.txt, six unreadable home pages, the request cap against a 40-link page, and hostile page content.

**Defects found and fixed in the fetcher**
- A compressed response (sent despite `Accept-Encoding: identity`) was decoded as text and treated as an inspected page with nothing on it, which would have produced false "not found" observations. Now refused.
- UTF-16, binary and invalid UTF-8 bodies were likewise read as garbage. Now refused; Latin-1 is decoded properly; other charsets are refused.
- An empty 200 response counted as an inspected page. Now unavailable.
- A redirect to a different site was followed unless the caller supplied an allowlist, and the transport never did, so another site's content could have been attributed to the business. Off-site redirects are now refused by default, before the other host is even resolved.
- HTTPS redirecting to plain HTTP was followed. Now refused.
- Malformed HTTP, TLS failures and truncated bodies were all reported as a retryable "network error". Now categorised; malformed and TLS failures are not retried.
- A declared `Content-Length` over the cap is refused before the body is read.

**General live research is still disabled.** `runtime.ts` constructs only the fixture transport. A second lock was added: investigations refuse any non-synthetic transport unless `config.liveFetchUnlocked` is true, `loadConfig` always returns false, and no environment variable sets it (tested). A test scans `src/` and fails if any file other than the fetcher itself uses it, sets the switch, or uses the `dial` seam.

### 4. Operator sign-in
- **One-click sign-in is removed.** There is no code path to a session without a secret.
- First run: the sign-in page asks for a one-time setup code that the server writes to `<data folder>/setup-code.txt`, and a passphrase of at least 12 characters. Only a salted scrypt hash (N=2^15, r=8, p=3) is stored. The code is stored only as a hash and destroyed on success.
- Failed attempts are counted globally. The previous limiter was keyed on the `X-Forwarded-For` header, so changing that header reset it (the old test demonstrated this by switching from `client-1` to `client-2`). Five failures in 15 minutes lock sign-in and setup; a correct secret is refused while locked; attempts during the lock do not extend it; existing sessions keep working.
- Sessions: 60-minute idle limit in addition to the 8-hour limit, at most 5, "Sign out all other sessions", change passphrase (needs the current one, ends other sessions). Sessions created by the old one-click sign-in are not honoured.
- The request proxy now refuses any `Host` header other than `localhost`, `127.0.0.1`, `[::1]` (or names in `OI_ALLOWED_HOSTS`) with 421. Without this, a web page could reach the app through DNS rebinding, because its `Origin` would match its own `Host`.
- `OPERATOR_PASSPHRASE` still works as an override but is plain text in the environment; a weak value is refused outright.
- `npm run auth:reset` removes the passphrase and sessions (needs access to the project folder), keeps research data.
- Failed attempts, lockouts, setup, passphrase changes and resets are in the audit trail.

**Effect on you:** the next time you open the app it shows "Set up sign-in". Open `.data/setup-code.txt`, paste the code, choose a passphrase.

### 5. Secret scanner
gitleaks 8.30.1 installed with `winget install --id Gitleaks.Gitleaks -e` (installer hash verified by winget). `npm run secret-scan` now runs gitleaks over the full git history and over the working folder, then the project-rule script. A missing scanner fails the check. `.gitleaks.toml` keeps all default rules, adds a rule for local user-directory paths, and skips only folders that are in `.gitignore`.
- **History, including the commit already published on `origin/main`:** 3 findings, all the made-up canary strings in `scripts/check-client-bundle.mjs`. Not secrets; recorded by fingerprint in `.gitleaksignore` with the reason. Those lines now carry `gitleaks:allow`.
- **Working folder:** 0 findings.
- The scanner was shown to fail on a planted GitHub-token-shaped string and on a planted local user path, and to pass again once they were removed.
- A pre-commit hook is provided in `.githooks/` but is **not** active; `npm run hooks:install` enables it.

### Commands and results (final run)
| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | 74 files, 0 errors, 0 warnings |
| `npm test` | 13 files, **461 passed, 0 failed, 0 skipped** (was 176). New: owner-view-audit 24, semantic-claims 95, live-fetch-controlled 111, auth-hardening 55. ssrf 72 → 73. authz 15 → 14 (the one-click test was removed with the feature). |
| `npm run secret-scan` | gitleaks: history 0, working folder 0; project rules: 0 findings |
| `npm run check:bundle` | 14 browser files, 0 findings |
| `npm run audit` | 0 vulnerabilities in production dependencies. Dev-tooling advisories unchanged and unfixed. |
| `npm run verify` | exit 0. Output: `docs/delivery/test-evidence/verify-output.txt`; every test by name: `vitest-verbose.txt` |

Browser check (dev server on a throwaway data folder, since deleted): first-run setup refused a wrong code and accepted the right one; the data file held only hashes; wrong passphrase refused and audited; right passphrase signed in; `auth:reset` returned the app to setup; the owner preview of the timeout example showed the rebuilt unknown wording with no "Timed out", no "Retry" and no internal IDs; no console errors. Probes with curl: `Host: attacker.example:3212` → 421; anonymous page → 307 to `/login`; anonymous or forged-cookie API → 401. Screenshots 14 to 17 in `docs/ux/screenshots/`.

### Failures and surprises along the way
1. 21 of 24 owner-audit tests failed on the unfixed code (the point of writing them first).
2. First run of the claim tests: 12 of 95 failed. Three were verifier defects (cross-field matching; "a call that was missed" read as a loss claim; number words in evidence not allowed in the claim). The rest were test wording.
3. First run of the fetcher tests: 110 of 111 passed; the remaining one was a platform-dependent expectation (a reset can surface on the request or the response).
4. One existing SSRF test changed meaning: a redirect to another site that resolves privately is now stopped earlier, as an off-site redirect. The test was split in two.
5. A forged session cookie on a page gets HTTP 200, not a redirect status: the page shell streams first and then redirects to `/login`. The body was checked and contains no protected content. API routes return 401.
6. Shell quoting broke two patch scripts again; edits were applied with file tools.

### Not done / not verified
- No real website fetched. No LLM. No database, no RLS. No CI. No egress restriction (the fetcher's checks are application-level only).
- No second factor. Lockout is global, so anyone who can reach the port can lock sign-in for 15 minutes (existing sessions are unaffected).
- The setup code file and the data file are readable by any program running as the same operating-system user.
- The fetcher resolves with the system resolver and pins the first answer; it does not try a second address if the first is unreachable.
- The two-context reasoning doubles reasoner calls when restricted evidence exists, and has only been exercised with rule-based and scripted test reasoners.
- A public-only claim can omit a restricted observation that contradicts it. The verifier's contradiction rule only sees evidence in the same context.
- Automated browser tests still do not exist. The owner preview at desktop width was checked by reading the page, not by screenshot (the browser pane was too small for a legible one).
- Accessibility still not audited. Outcomes, discovery, search, retention and delete still not built.

### Blockers (need the owner)
1. Review this branch and decide whether to merge it. It is not pushed.
2. Third-party comment policy (unchanged). The owner preview now counts such observations so the decision is visible each time.
3. Phase 2 approval and site choices (unchanged).
4. Whether to enable the pre-commit hook, and whether to add CI now that a remote exists.

### Exact next step
Owner or independent reviewer: `git switch review/milestone-1-hardening`, `npm install`, install gitleaks if absent, `npm run verify`, then `npm run dev` and complete "Set up sign-in". Review `CLAUDE_REVIEW_PACKET.md` section "Review branch". If accepted, merge to `main` yourself.

---

## 2026-11-18 — Phase 2 gate: operator live test, three real HVAC websites (branch `feature/live-evidence-prototype`)

**Requested by the owner.** The hardening branch was pushed first: `origin/review/milestone-1-hardening` is at `4801fe5`, confirmed with `git ls-remote`. `main` was not touched, nothing was merged or deployed, `AGENTS.md` was left alone. This work is on a new local branch cut from the hardening branch. It has not been pushed.

**Real businesses are not named in this repository.** They are called A, B and C here. Names, hostnames, the approvals file, the three internal reports and the verification table are in `research-private/live-test/`, which git ignores (`.gitignore`, and the launcher refuses to run otherwise).

### What was built (smallest thing that could do the job)
- The web app is unchanged in this respect: mock-only, cannot construct a live transport.
- A separate launcher, `scripts/live-investigate.mjs`, runs ONE investigation of ONE business named in an operator approvals file. Without `--confirm-live` it prints what it would contact and stops.
- `createApprovedLiveTransport` (replaces the generic live transport, which no longer exists): reaches only the exact hostnames approved for that business; redirects may land only on an approved hostname; 2 s pause between requests; hard ceiling of 20 requests on the wire; GET only, no cookies, no forms.
- The socket layer refuses, at connect time, any non-public address, any port other than 80/443 and any unapproved host, and checks the peer address after connecting. This is a third check, independent of URL validation.
- Investigations refuse a live transport with no approved-host list and never request a website that is not on it.
- Approvals file (`tools/live-test/approvals.ts`): exact hostnames; only the business's domain and its `www.` form; at most 5 businesses; expires after 14 days; must be outside version control.
- Internal Markdown report per run with identity, scope, pages, every observation with ID, source address, time, status and confidence, unknowns, verifier output and the full request log.

### Network safety requirements: checked before any request, one not met, owner decided
| Requirement (SECURITY_PROTOCOL "Safe fetching") | Status |
|---|---|
| http/https only; parser-validated URLs; no credentials, localhost, private, link-local, metadata or non-public DNS answers | Met (tests) |
| Validate every connection and redirect hop; connect to the validated address | Met (tests) |
| Cap redirects; no alternate schemes or unusual ports | Met (tests) |
| Limit bytes, content types, depth, timeouts, concurrency, total requests | Met (5 pages, 1 MB, 10 s, sequential, 8 page requests, 20 on the wire) |
| Respect robots.txt and access restrictions; stop at denial or bot checks | Met (and extended: see defects 3 and 4 below) |
| **Apply egress network restrictions** | **Not met at operating-system or network level.** Enforced inside the application only, at three points. The builder cannot add a firewall rule (a system security setting). |

Work stopped there and the owner was asked. **Owner's decision (recorded in the approvals file): "Proceed, app-level only"**, accepting the remaining risk for these supervised runs only. It remains a blocker for any hosted, unattended or wider live use.

### Approvals given by the owner, in order
1. Three exact hostnames (a fourth, offered as a spare, was not approved and was never requested).
2. After the first runs: plain HTTP for one `www.` hostname of A (its HTTPS address redirects there), and a new hostname for C (the directory-listed domain forwards to it).

### What happened
| | A | B | C |
|---|---|---|---|
| First attempt | Stopped: HTTPS redirects to plain HTTP. Nothing read, nothing concluded. | Completed | Stopped: listed domain redirects to another hostname. Not followed. |
| Final run | review_ready, 3 pages, 10.1 s, 9 requests on the wire | review_ready, 3 pages, 8.2 s, 4 requests | review_ready, 5 pages, 17.0 s, 10 requests |
| Identity | confirmed from the site's own text | confirmed from the site's own text | confirmed from the site's own text |
| robots.txt | read and applied (on the origin that serves the site) | read and applied | read and applied |
| Observations | 5 | 4 | 5 |
| Opportunities proposed | 0 | 0 | 0 |
| Requests in stopped attempts | 13 | 0 | 4 |

No page was refused with 401/403/429, no bot check appeared, no robots.txt rule disallowed a requested page. No form was submitted. No request went to any host outside the approvals.

### Manual verification (by the builder, in a browser, read-only; 11 page views)
14 tool observations checked against the original pages:

| Verdict | Count |
|---|---|
| Verified | 12 |
| Verified but incomplete (the site states two different office hours; the tool reported one) | 1 |
| **Unsupported: false positive** | **1** |

**The false positive:** for C the tool recorded "no statement about after-hours or emergency availability on the 5 pages inspected". The contact page says "emergency HVAC service". The rule only recognised "emergency service" with the words adjacent. This would have been a false "not found" claim about a real business. It was caught only because the page was read by hand. The rule is fixed and has a regression test with the exact wording; the stored observation is flagged in the verification file for rejection in review.

Unknowns recorded for all three: how calls are answered, how form submissions are followed up, pages beyond the 3 to 5 read, business size, search and review presence.

**Commercial usefulness (builder's assessment; the operator decides):** the tool proposed no opportunity for any of the three, correctly. All three show a phone number and a contact form; two state 24-hour emergency service. There is no evidence of a missed lead and none is implied. The evidence supports one or two neutral questions per business (for example: two different sets of office hours on one site; advertised 24-hour service next to office hours that end mid-afternoon). None meets the product's own standard for a defensible opportunity. Phase 2 gate result on usefulness: **0 of 3 reports with a defensible opportunity; 3 of 3 with a grounded question.**

### Defects found by running against real sites (all fixed, all with tests)
1. **False "not found" for emergency availability** (above). Any mention of emergencies, "open 24" or "day or night" now counts.
2. **Inner pages were requested on the wrong address.** A's home page is served from `www.`; the tool kept asking the bare domain, which returns 404 for everything but `/`. The investigation now continues on the origin the home page was served from, if that host is approved.
3. **robots.txt of a redirect target was not read.** robots.txt belongs to an origin. The transport now reads the target origin's robots.txt before following a redirect that leaves the current origin, and the investigation reads it again for the origin it continues on (served from the run's cache, not requested twice).
4. **A refused redirect did not say where it pointed**, so the operator could not decide whether to approve it. The log now names the scheme and hostname only; the target is still never requested.
5. **Truncated, script-drawn or widget-embedding pages could produce "not found".** Pages now carry `readLimits`; any such page turns the absence into an unknown. (Found by reading the extractor before the run, not by a failure.)
6. **Identity check only recognised "City, ST".** It now reads "City, Michigan" and "City MI 49080" and accepts only real state names and codes.
7. The page's final address and redirect count were not stored. They are now, and an observation whose page arrived over plain HTTP carries an `unencrypted_http` caveat.

Still wrong or weak, not fixed: the tool reports the first office-hours statement it finds and does not notice a conflicting one; "Open 24 Hours" is not read as office hours; a "Get a Quote" button is typed as a booking link; only the first matching form or link per site is described.

### Commands and results (final run)
| Command | Result |
|---|---|
| `npm run verify` | exit 0: typecheck; lint 0 errors, 0 warnings; **14 test files, 522 tests passed, 0 failed, 0 skipped** (was 461); gitleaks history 0 and working folder 0; project-rule scan 0; bundle check 0; `npm audit --omit=dev` 0 |
| New tests | `tests/live-approved-hosts.test.ts` (53): approved-host transport, approvals file, launcher refusals, end-to-end runs against a controlled TLS site. `tests/live-fetch-controlled.test.ts` +3, `tests/ssrf.test.ts` +2, `tests/extract-robots.test.ts` +3 |
| Live runs | see "Reproduce" below; output in `research-private/live-test/reports/` |

Output: `docs/delivery/test-evidence/verify-output.txt`, `vitest-verbose.txt`.

### Reproduce the three investigations
Needs the approvals file (untracked; expires 14 days after its `approvedAt`).
```
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --list
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --business A --confirm-live
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --business B --confirm-live
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --business C --confirm-live
```
Each prints the hostnames it may reach, then writes `research-private/live-test/reports/<label>-internal-report.md`. Evidence IDs change on every run. A reviewer without the approvals file can run the same code against controlled servers: `npx vitest run tests/live-approved-hosts.test.ts`.

### Phase 2 gate ("three real permitted websites tested, no forms submitted, findings manually verified")
- Three real, operator-approved websites tested end to end: **yes.**
- No forms submitted: **yes** (the controlled-server test asserts it; the live request logs show GET only).
- Findings manually verified: **yes, by the builder.** 13 of 14 hold; 1 was false.
- Not done: verification by the operator; any timing of a person doing it; a repeat visit; more than 5 pages per site.

### Remaining blockers
1. **No network-level egress restriction.** Accepted by the owner for this test only.
2. **The operator has not reviewed the 14 observations** in the tool (all are `needs_review`). The app cannot display this data yet: it only opens its own data folder and labels everything as mock. One observation must be rejected.
3. **Retention for live data is still undefined.** For this test everything is in one ignored folder that can be deleted by hand. That is a workaround, not a policy.
4. **The verifier and extractor rules were tuned on three sites.** One in fourteen observations was false. That rate is not good enough for unattended use and is not a measured precision; the sample is too small.
5. Independent review of both branches has not happened.
6. Third-party comment policy (unchanged).

### Exact next step
The operator reads `research-private/live-test/reports/VERIFICATION.md` and the three reports against the live pages, and decides (a) whether a grounded question without a proven problem is enough to start a conversation, and (b) whether to merge the two branches. No further build work is proposed here.
