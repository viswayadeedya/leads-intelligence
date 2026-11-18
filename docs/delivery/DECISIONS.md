# Architecture Decision Record

## ADR-001 — Modular monolith
**Decision:** Next.js + TypeScript with separate internal modules and optional background worker.
**Reason:** fast vibe-coded delivery and low operational burden.
**Revisit:** only when runtime limits or workloads demand it.

## ADR-002 — Evidence-first output
**Decision:** provenance and uncertainty required before reports.
**Reason:** trustworthy owner-facing diagnostics are the differentiator.

## ADR-003 — Social as manual research first
**Decision:** search discovery + human-reviewed observations; no automated scraping of authenticated Facebook/Reddit sessions.
**Reason:** access/privacy/terms and data quality risks.

## ADR-004 — No auto outreach
**Decision:** draft and approve only.
**Reason:** quality, reputation, and compliance.

## New decisions
Append date, alternatives, rationale, implications, and test evidence. Do not overwrite historical decisions silently.

---
All entries below: 2026-11-18, made by Claude during the Phase 0 + Phase 1 build. Each is reversible.

## ADR-005 — Mock mode persists to a local JSON file behind a `Store` interface
**Decision:** `JsonFileStore` (`.data/db.json`, untracked) for the app, `MemoryStore` for tests. The Supabase schema is written (`supabase/migrations/0001_init.sql`) but not applied.
**Alternatives:** Supabase local (needs Docker and a project), SQLite via `node:sqlite` (bundler/test-runner risk).
**Rationale:** "App works without paid keys." Every service takes the store through a context, so swapping in Postgres is one implementation.
**Implications:** No encryption at rest, single process only, no backups. Owner scoping is enforced in application code (`getOwned`/`listOwned`), not by database RLS. RLS remains **untested** and blocks live mode.
**Evidence:** `tests/authz.test.ts` (cross-user denial on every service), `tests/api-routes.test.ts` (real file store).

## ADR-006 — This build is mock-only; live mode cannot be switched on
**Decision:** `config.mode` is always `mock`. `APP_MODE=live` only shows a warning banner. The guarded live fetcher (`src/lib/security/safe-fetch.ts`) exists and is unit-tested but is never constructed by the app.
**Rationale:** Security protocol release gates for "Live internal" (RLS verification, egress restrictions, retention, staging review) are not met. No silent mock→live switch.
**Resolves a contradiction:** `ROADMAP.md` Phase 1 is a mock slice; `DEFINITION_OF_READY.md` Phase 1 says "one live vertical slice". Per `docs/INDEX.md` precedence (security protocol first, roadmap before product preferences) the roadmap order was followed and live fetch stays in Phase 2.

## ADR-007 — Single-operator sessions; one-click sign-in only when no passphrase is set
**Decision:** Server-side sessions (random token, stored as SHA-256 hash, HttpOnly SameSite=Strict cookie, 8-hour default). With `OPERATOR_PASSPHRASE` unset, mock mode offers a one-click local sign-in; once set, the passphrase is required and attempts are rate limited (5 per 15 minutes). The server binds to 127.0.0.1.
**Alternatives:** Supabase Auth (needs credentials), mandatory passphrase (blocks "start in 60 seconds with no instructions").
**Residual risk (needs owner acceptance):** without a passphrase, any process or user on this machine that can reach port 3210 can sign in. No MFA. The passphrase is compared as a plain environment value, not a slow hash.

## ADR-008 — Server Actions for all mutations; two read-only API routes
**Decision:** Mutations are Next.js Server Actions that call owner-scoped services. Only `GET /api/investigations/:id` and `GET /api/reports/:id/export` exist as HTTP API.
**Deviation:** `API_CONTRACTS.md` proposes ten REST endpoints ("proposed"). The rest are not implemented; the same operations exist as services.
**CSRF:** SameSite=Strict cookie + an Origin-must-match-Host check in `src/proxy.ts` for every non-GET request + the framework's own Server Action origin check.

## ADR-009 — The "reasoner" is a deterministic rule set; no LLM is called
**Decision:** `MockRuleReasoner` (`mock-rules-v1`) proposes opportunities from typed evidence; its output is treated as untrusted JSON and passes the same strict schema and verifier an LLM would.
**Implication:** Prompt-injection resistance is proven only structurally (no tools, strict schema, evidence-ID allowlist, hostile-output tests). **It is not tested against a real model.**

## ADR-010 — The claim verifier is heuristic and English-keyword based
**Decision:** Hard checks (evidence ID exists in this run, right business, identity confirmed, not rejected/superseded, absence only with complete collection, confidence ≤ weakest evidence, numbers must appear in cited evidence) plus keyword rules (money, loss, systemic wording, "currently" on stale evidence, unscoped absence, locality on geo-uncertain evidence).
**Limit:** Keyword rules can be evaded by paraphrase. Human evidence review is the gate that matters; nothing reaches the owner view without explicit acceptance.

## ADR-011 — Absence is only asserted after complete collection
**Decision:** "No X found on the N pages inspected" is produced only when every planned page was fetched successfully and the budget was not hit. Otherwise the question is stored as an *unknown* with the reason.
**Trade-off:** Conservative: a single dead link (404) on a site suppresses absence observations for that run.

## ADR-012 — Evidence may cite several source records; observations are immutable
**Deviation from `DATA_MODEL.md`:** `evidence.source_record_id` became `sourceRecordIds[]` because a website observation spans several pages. When a retry changes an observation, the old row is kept and marked superseded.

## ADR-013 — Owner view fails closed
**Decision:** A finding appears in the owner preview/export only if it is supported, accepted by the operator, and *every* cited observation is accepted, classified `public`, confirmed for this business and backed only by `PUBLIC_BUSINESS` sources fetched successfully. A finding resting on any withheld observation is withheld entirely. Gated sources (login, private group) are stored as `restricted` whatever the operator selects.
**No share links:** `reports.share_token_hash` from `DATA_MODEL.md` is intentionally omitted (`SECURE_BUILD_PIPELINE.md`: "no share tokens in MVP").

## ADR-014 — No send capability; "sent" is a record of what the human did
**Decision:** There is no email/form/call/post code. "Mark manually sent" needs a single-use approval token bound to the exact text, recipient, action and expiry; it is refused for fictional businesses and for non-human actors.

## ADR-015 — Stage and status vocabulary
**Decision:** Run states follow `SYSTEM_DESIGN.md` (not the slightly different list in `AGENT_BOUNDARIES.md`). A seventh stage status, "Not checked", was added to the six in `SCREEN_BLUEPRINTS.md` because `UX_PRINCIPLES.md` requires it to be distinct.

## ADR-016 — Tooling
Plain CSS (no UI framework); `parse5` for HTML parsing; `zod` for boundary validation; a local `scripts/secret-scan.mjs` as a stopgap because gitleaks is not installed (installing a binary needs the owner's approval); Next.js telemetry disabled via `scripts/run-next.mjs`. Dependencies are pinned to exact versions with a lockfile.

## Residual risks recorded (see also `CLAUDE_REVIEW_PACKET.md`)
- 16 "high" advisories in **development** tooling only (picomatch ReDoS, GHSA-fc5q-39xc-vjpf, via vitest/eslint). `npm audit --omit=dev` reports 0. Not fixed: the offered fix downgrades vitest two major versions.
- No egress network restrictions, no IP-level request rate limiting, no retention/deletion/export features, no CI.
- Excerpts are length-bounded but not scanned for personal data; relevant before live website fetching.

## Open questions that are the owner's to decide
1. **Source rights for third-party comments.** The tool lets the operator classify a paraphrased public comment (with its link) as shareable in an owner report. Review-site and forum terms may restrict commercial reuse. Decide the policy before real research notes are entered.
2. **Phase 2 go-ahead.** Fetching real business websites, and which three sites to test on, needs explicit approval and the live-mode gates.
3. **Passphrase requirement.** Whether one-click local sign-in is acceptable on this machine.

## ADR-017 — Version control hygiene (2026-11-18)
**Decision:** Repository initialised locally on `main`; no remote. `.gitignore` excludes environment files (except the sanitized `.env.example`), key and credential files, cookies/session state/HAR captures, local databases (`.data/`), private research folders and exports, logs, build output and scanner reports. Folder names that could plausibly become app routes (`sessions`, `exports`, `downloads`, `leads`, `prospects`, `logs`, `videos`) are ignored at the repository root only, so a future `src/app/leads/` is not silently dropped. `.gitattributes` normalises line endings.
**Tracked on purpose:** `.claude/launch.json` (local dev-server definitions, no secrets); `docs/ux/screenshots/` and `docs/examples/` (synthetic only); `docs/delivery/test-evidence/` (captured output with the local path replaced by `<repo>`).
**Implication for future work:** real research data must never be placed under `src/fixtures/` or `docs/examples/`; those folders are tracked. Captured command output must be sanitized before it is saved under `docs/`; the stopgap scanner now fails on local user-directory paths.
**Not done:** no established secret scanner (gitleaks) has been run; none is installed.

---
Entries below: 2026-11-18, review branch `review/milestone-1-hardening`. Each is reversible.

## ADR-018 — The owner view is an allowlist type; unknowns are structured
**Decision:** `OwnerReportView` is a separate type built field by field in `buildOwnerView`. Nothing is spread or copied from the internal view. Unknowns carry `kind`, `topic` and counts; the owner wording is rebuilt from those and from the access status of the referenced records. Stored free text (`question`, `reason`, `accessDetail`, excerpts, notes) is never printed for an owner.
**Why:** the previous owner view reused the internal type and passed `run.unknowns` through verbatim. Review found seven kinds of internal text reaching owner output.
**Trade-off:** owner unknowns are less specific (they no longer name the page or say why it failed). An unknown written by future code without the structured fields is silently withheld and only counted; the redaction summary shows the count.
**Supersedes:** the part of ADR-013 that described the owner view as a filtered internal view.
**Evidence:** `tests/owner-view-audit.test.ts`.

## ADR-019 — Reasoning runs in two contexts
**Decision:** claims that may reach an owner are written in a pass that is shown only public observations and can cite only those. A second pass, run only when restricted evidence exists, sees everything; from it only claims that cite restricted evidence are kept, marked `includes_restricted`, and never shared. A claim with no recorded context is not shareable.
**Why:** checking cited evidence IDs does not stop a model from paraphrasing a restricted note into a claim that cites public evidence.
**Cost:** a second reasoner call when restricted evidence exists. **Limits:** exercised only with rule-based and scripted reasoners; a public-only claim can omit a restricted observation that contradicts it.

## ADR-020 — The verifier fails closed on wording, and its gaps are written down as tests
**Decision:** about twenty rule families over normalised English text (see `verifier.ts`). Interpretations must be hedged; fixes must be conditional; absence claims are checked sentence by sentence and feature by feature. Text with invisible characters, mixed alphabets or markup is refused rather than interpreted.
**Trade-off:** honest claims that use a listed word are rejected (and logged with a code). That costs findings, never publishes one. The false-rejection rate with a real model is unknown.
**Known gaps** are asserted as passing tests in `tests/semantic-claims.test.ts` part 2, so they stay visible. Extends ADR-010.

## ADR-021 — Live fetching stays locked; it is tested against controlled servers only
**Decision:** `config.liveFetchUnlocked` is always false from `loadConfig`, with no environment variable. Investigations refuse a non-synthetic transport without it. The fetcher gained a test seam (`createPinnedRequest({ dial, ca })`) so tests can point validated public-looking addresses at servers on 127.0.0.1.
**Fetcher rules added:** redirects stay on the requested host (with or without `www.`) by default; HTTPS never falls back to HTTP; compressed, non-UTF-8/Latin-1, binary and empty bodies are not inspected pages; failures are categorised.
**Residual risk:** the seam is production code. A test fails if application code uses it. Egress restriction is still absent and still required before live mode (ADR-006 stands).

## ADR-022 — Operator sign-in: setup code, hashed passphrase, global lockout, host-name check
**Decision:** one-click sign-in is removed. First run needs a one-time code written to the data folder plus a chosen passphrase (12+ characters), stored as scrypt (N=2^15, r=8, p=3). Lockout after 5 failures in 15 minutes is global. Sessions have an idle limit, a cap, and can be ended together. The proxy refuses unknown `Host` headers.
**Alternatives considered:** printing the code to the console (puts a secret in logs); trust-on-first-use with no code (whoever reaches the port first owns the app); keeping one-click behind a flag (a flag that removes authentication is a liability).
**Supersedes ADR-007.** Open question 3 below ("is one-click acceptable") is closed by the owner's instruction to harden sign-in.
**Residual risks:** no second factor; a local attacker can cause repeated 15-minute lockouts; the code file and data file are readable by the same operating-system user; `OPERATOR_PASSPHRASE` remains a plain-text override; a forgotten passphrase needs `npm run auth:reset` on the machine.

## ADR-023 — gitleaks is the secret scanner; a missing scanner fails the check
**Decision:** `npm run secret-scan` runs gitleaks (>= 8.25) over all git history and the working folder, then the project-rule script. Default rules are all kept. Deliberate fakes are marked at the line or by fingerprint with a reason; no source folder is allowlisted.
**Trade-off:** `npm run verify` now needs a separately installed binary. Chosen over an npm-installed scanner because gitleaks is what the security protocol names.
**Not done:** the pre-commit hook exists but is not enabled; there is no CI. Replaces the "stopgap" part of ADR-016.

## Open questions that are the owner's to decide (current)
1. **Third-party comments in owner reports** (unchanged, still open). The owner preview now shows how many such observations a report includes.
2. **Phase 2 go-ahead** (unchanged, still open).
3. ~~One-click local sign-in~~ Closed: removed.
4. **Merge of `review/milestone-1-hardening` into `main`**, and whether to enable the pre-commit hook and add CI.

---
Entries below: 2026-11-18, branch `feature/live-evidence-prototype`.

## ADR-024 — Operator live test: approved hostnames only, outside the web app
**Decision:** real requests are possible only through `scripts/live-investigate.mjs`, for one business at a time, to the exact hostnames listed for that business in an operator approvals file. The web app stays mock-only. The generic live transport was removed; `createApprovedLiveTransport` is the only transport that can make a real request.
**Why not a mode of the app:** an environment switch on a running server is easier to leave on, and the app's screens say "mock" throughout. A separate command that names its target every time is harder to misuse.
**Limits fixed in code, not configurable from the environment:** 5 pages, 8 page requests, 20 requests on the wire, 10 s, 1 MB, 3 redirects, 2 s between requests.
**Supersedes** the "locked, never used on a real site" part of ADR-021. ADR-006 (the app is mock-only) stands.

## ADR-025 — Owner accepted application-level egress enforcement for the three-site test
**Context:** the security protocol requires network-level egress restrictions before live fetching. None exists. The builder cannot change firewall settings.
**Decision (the owner's, 2026-11-18):** proceed with application-level enforcement only, for these supervised runs. Recorded verbatim in the approvals file.
**What enforces it:** the transport's host list; `safeFetch` validation of every URL, DNS answer and redirect; the socket layer's connect-time check of host, address and port, and of the peer address after connecting.
**Scope:** this acceptance does not extend to a hosted, scheduled, unattended or larger live use. For those the requirement is unmet and blocks.

## ADR-026 — Real businesses are never named in the repository
**Decision:** names, hostnames, approvals, reports and verification tables for real businesses live in `research-private/` (git-ignored). Tracked documents use labels (A, B, C). The launcher refuses an approvals file or output folder that git would track.
**Why:** reports are private by default (security protocol); the repository has a remote; a prospect list with hypotheses about named businesses is not something to publish by accident.
**Cost:** an independent reviewer cannot check the findings from the repository alone. The owner has to share the private folder.

## ADR-027 — Evidence rules changed after contact with real pages
- A page that was truncated, is drawn by scripts, or embeds a third-party form, scheduler or chat widget cannot support "not found"; the question becomes an unknown.
- robots.txt is read per origin, including the origin a redirect leads to, before anything is requested there.
- The investigation continues on the origin the home page was served from, when that host is approved.
- HTTPS-to-HTTP redirects stay refused unless the operator allows plain HTTP for that exact hostname; observations from pages that arrived over plain HTTP carry a caveat.
- Any mention of emergencies counts as an after-hours statement (a narrower rule produced a false "not found" on a real site). **Withdrawn by ADR-028.**
**Limit:** these were written after seeing three sites. They are not validated beyond those.

## ADR-028 — Hours and availability are reported as statements, never resolved
**Context:** independent review of `9fc7241`. One hours match was kept per page, and any mention of an emergency counted as a positive after-hours statement (the last rule of ADR-027).
**Decision:**
- Every distinct hours statement is kept with its pages, text and context. Statements are classed as office, emergency/after-hours, or qualified by a season or department.
- A conflict is reported only between statements of the same class and label that give different values for a shared day. The tool never says which is right.
- Wording about emergency or after-hours service is classed affirmative, emergency offer without hours, negative or ambiguous. Only affirmative wording is positive evidence. Any wording at all prevents "no statement was found".
- The last rule of ADR-027 is withdrawn.
**Why:** a web page can show what a business says. It cannot show which of two statements is current, and a mention is not an offer.
**Cost:** more observations are neutral and low-confidence, so fewer feed a claim. That is the intended direction.

## ADR-029 — robots.txt: one rule for both layers, fail closed
**Decision:** `robotsStateFromOutcome` is the only place that turns an answer into a policy. Rules read, an empty file, or HTTP 404/410 permit requests. Every other answer means the rules are unknown and nothing is requested from that origin. Refusals, rate limits and unreadable answers are not retried; server errors and timeouts may be retried by the operator.
**Why:** a refusal to show the rules is an access restriction, and the security protocol says to stop at access restrictions.
**Cost:** stricter than RFC 9309. Sites that block robots.txt cannot be inspected.

## ADR-030 — Operational and commercial claims need matching evidence
**Decision:** a claim about missed or unanswered contact, voicemail or reply times must cite an account of what happened (a comment, an owner statement, an operator observation). A claim about conversion, sales or revenue must cite the owner's own statement. Hedging does not exempt a claim. Questions to the owner, alternative explanations and conditional fixes are not claims and are not checked by these two rules.
**Why:** a website observation is not an operational fact, and only the business knows its own results.
**Limit:** the rules are vocabulary lists. They do not understand a sentence.

## Open questions that are the owner's to decide (current)
1. **Third-party comments in owner reports** (unchanged).
2. **Is a grounded question enough?** Three real investigations produced no defensible opportunity and one or two fair questions each. Whether to approach an owner on that basis is a commercial decision, not an engineering one.
3. **Merge** of `review/milestone-1-hardening` and `feature/live-evidence-prototype`.
4. **Retention for live data**, and network-level egress control, before any further live use.
5. **A supervised re-read of the three approved sites** under the corrected rules (ADR-028, ADR-029). Not done; it makes real requests and needs the owner's approval. The existing private reports predate the corrections.
