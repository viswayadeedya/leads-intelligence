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
