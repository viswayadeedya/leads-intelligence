# Build Log

Status: **Phase 0 and Phase 1 (roadmap numbering) built in mock mode. Live mode is not available. Awaiting independent review; nothing here is self-certified.** Committed locally as the root commit of `main`; no remote, not pushed.

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
