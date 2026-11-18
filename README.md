> **Read first:** `HUMAN_CODE.md`, `PAIN_FIRST.md`, `docs/security/SECURITY_PROTOCOL.md`, then `CLAUDE.md`. These documents govern all implementation decisions.

# Opportunity Intelligence Engine

An evidence-first, internal prospect research and business opportunity investigation system for a small AI automation agency, initially focused on HVAC businesses.

**Start here:** Read `CLAUDE.md`, then `docs/INDEX.md`. Do not start implementation before reading the source, evidence, and acceptance-test contracts.

## North star
Produce a report that a real business owner could inspect and challenge: observed facts with provenance, clearly separated hypotheses, gaps to verify, and relevant fixes. Help the agency earn qualified conversations and paid pilots, not merely generate lead lists.

## Initial operator workflow
Discover or enter business → verify identity → inspect permitted sources → assemble evidence → investigate customer journey → identify opportunities → human review → draft outreach → track outcomes.

## Non-goals
Mass scraping of restricted platforms; fabricated customer complaints; unverified revenue-loss estimates; automatic posting or outreach; comprehensive SEO software; production-grade public SaaS in v1.

## Build strategy
Modular Next.js/TypeScript monolith, Supabase/Postgres, Playwright for permitted public websites, LLM provider abstraction, source adapters, mock mode, automated tests. Prefer working vertical slices over decorative dashboards.

## Quick start for Claude
1. Read `CLAUDE.md` and `docs/INDEX.md`.
2. Inspect existing repository before changing it.
3. Implement phase 0 and phase 1 in `docs/delivery/ROADMAP.md`.
4. Run tests and log proof in `docs/delivery/BUILD_LOG.md`.
5. Continue autonomously through approved phases unless blocked by a real external dependency.

## Running it (commands executed on 2026-11-18, Node 24.22.1, npm 12.2.1, Windows 11)
No credentials are needed. The app runs in **mock mode only**: website checks read fictional fixtures, nothing is fetched from the internet, and nothing can be sent.

```
npm install
npm run dev          # http://127.0.0.1:3210 (this computer only)
npm run verify       # typecheck + lint + tests + secret scan + client-bundle check + prod dependency audit
```

**First run:** the sign-in page shows "Set up sign-in". Open `.data/setup-code.txt`, paste the code, and choose a passphrase (12 characters or more). Only a salted hash of it is stored. Forgot it? Stop the app and run `npm run auth:reset`; research data is kept.

**`npm run verify` needs gitleaks** (8.25 or newer) installed: `winget install --id Gitleaks.Gitleaks -e` on Windows, `brew install gitleaks` on macOS. Without it the secret scan fails rather than being skipped. `npm run hooks:install` turns on a pre-commit hook that runs the same scan (off by default).

Individual checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run secret-scan`, `npm run check:bundle`, `npm run audit`. Production mode: `npm run build` then `npm start`.

- Data lives in `.data/db.json` (untracked). Delete that folder to start clean.
- All settings are listed in `.env.example`. `OPERATOR_PASSPHRASE` is an optional plain-text override of the stored passphrase; leave it empty for normal use.
- The app answers only to `localhost`, `127.0.0.1` and `[::1]`. Other host names are refused unless listed in `OI_ALLOWED_HOSTS`.
- What works, what is mocked and what is not built: `docs/delivery/CLAUDE_REVIEW_PACKET.md`.
- Five-task walkthrough and screenshots: `docs/ux/WALKTHROUGH.md`.

### Operator live test (real websites; off unless you run it)
The app itself never fetches a real website. One separate command can, for one business at a time, and only for hostnames you approved in a file that git does not track:

```
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --list
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --business A                  # prints what it would contact, requests nothing
node scripts/live-investigate.mjs --approvals research-private/live-test/approvals.json --business A --confirm-live   # makes real requests
```

It reads at most 5 pages with GET, honours robots.txt, waits 2 seconds between requests, never submits a form, and writes an internal report next to the approvals file. The approvals format is defined in `tools/live-test/approvals.ts`; an approval expires after 14 days. There is no operating-system firewall rule behind the app's own checks; see ADR-025 before using it on anything beyond a supervised test. Real businesses must never be named in tracked files.

### Code map
- `src/lib/services/` — owner-scoped operations: businesses, investigations (state machine), evidence review, analysis, reports, outreach.
- `src/lib/reasoning/` — reasoner boundary (rule-based mock; no LLM) and the claim-to-evidence verifier.
- `src/lib/sources/` — page transport interface, mock fixture transport, HTML extraction, robots.txt, website evidence rules.
- `src/lib/security/` — SSRF guard, guarded fetch (locked; tested only against controlled local servers), passphrase hashing, origin/host/CSP helpers.
- `src/fixtures/golden.ts` — 15 fictional golden cases.
- `src/app/` — screens, server actions and two read-only API routes. `src/proxy.ts` — CSP, origin check, sign-in gate.
- `tests/` — 715 tests including the security negative tests. `tests/lab/` is a controlled local network for the fetcher tests; nothing in it leaves this computer.
- `tools/live-test/` and `scripts/live-investigate.mjs` — the operator live test (see below). The only code that can make a real request.
- `supabase/migrations/0001_init.sql` — schema with row-level security. **Not applied, not tested.**

## V3: UX and production-minded validation
Before coding, read `docs/ux/UX_PRINCIPLES.md`, `docs/ux/SCREEN_BLUEPRINTS.md`, `docs/architecture/AGENT_BOUNDARIES.md`, `docs/quality/EVALUATION_HARNESS.md`, and `docs/delivery/DEFINITION_OF_READY.md`. This is an internal, single-operator MVP. Do not build public onboarding or claim untested integrations work.
