# Implementation Roadmap — Autonomous, Gated

## Phase 0 — Foundation
Set up Next.js/TypeScript, styling, test framework, Supabase schema/migrations, typed models, mock fixtures, env template, README commands. **Gate:** app starts without keys; typecheck/tests pass.

## Phase 1 — Trustworthy vertical slice
Manual company → mock source evidence → structured LLM-like mock reasoning → evidence verifier → report → editable outreach draft. Build UI around actual workflow, not generic analytics. **Gate:** complete flow demonstrated with synthetic data; evidence adversarial tests pass.

## Phase 2 — Live public website adapter
Safe URL fetch, robots/terms-aware access, contact page discovery, visible form/booking/contact inspection, optional Playwright screenshots, errors and timestamps. **Gate:** three real permitted websites tested, no forms submitted, findings manually verified.

## Phase 3 — Business discovery
Google Places adapter behind feature flag; field masks, pagination, deduplication, provider ID matching, cost guard. Manual fallback always works. **Gate:** location-scoped run with verified businesses, no silent duplicates.

## Phase 4 — Conversation research workspace
Search URL discovery and manual Facebook/Reddit observation entry, sensitivity controls, identity verification, share filters. **Gate:** restricted/private evidence cannot leak to owner report.

## Phase 5 — Research quality and commercial loop
Adaptive follow-up checks, prioritization, review dashboard, outreach outcomes, exports, instrumentation. **Gate:** 20-business manual evaluation with measured precision, time, and cost.

## Phase 6 — Optional providers
AI search visibility SERP API, Yelp where licensed, authorized social integrations, owner-facing self-service. Only after earlier phases demonstrate demand and legal/commercial viability.

## Execution rules
Build phases in order; keep every phase deployable. When a paid API key is missing, continue in mock mode. Do not wait for user to make minor engineering choices. Log each gate result. Avoid premature distributed architecture.
