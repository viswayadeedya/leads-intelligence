# Source implementation contracts — no vague integrations

## Google Places
Purpose: discover real businesses and comparable local alternatives. Inputs: city/region, service category, search radius or region, limit. Use documented Places Text Search endpoint with field mask; request minimal fields. Store provider place ID, name, address, website when returned, retrieval time, cost and identity match. Handle pagination, duplicate locations, missing sites, quotas and terms. No claims about rankings from one Places search.

## Business website
Start from verified domain; fetch homepage and bounded contact/services/booking pages or sitemap URLs. Record status, canonical URL, redirect chain, title, visible links, contact methods, page inspection scope, accessibility of forms. Playwright only when needed for JS rendering. No form submission, booking, checkout, login, or phone calls without approval. 'Not found on inspected pages' ≠ 'does not exist'.

## Search-engine discovery
Issue transparent query recipes combining company identity, service area, complaint keywords, and source constraints. Store query, search provider, locale, time, result title, snippet and URL subject to provider terms. Search snippets are leads for verification, not conclusive proof. Avoid conflating similar business names.

## Reddit/Facebook
Use permitted public discovery and operator-assisted authenticated research. Do not automate logged-in scraping, access private groups via crawler, evade controls or store session cookies. Manual notes: source link (if shareable), observer, timestamp, minimal paraphrase, rights classification, visibility, identity uncertainty. No automatic owner-facing export of restricted material. If authorized API/data access is later secured, add separate adapter with documented scope and tests.

## AI-search visibility
Define fixed user-like query set, geography, device, language and observation date. Only claim presence/absence in the observed sample from the actual search surface/provider. Ordinary LLM output is not proof of consumer ChatGPT search visibility. Provider limitations, costs and retention must be recorded. This is phase 2 unless budget/credentials make it trivial.

## Review/competitor sources
Use permitted APIs and public sites according to their terms; record sampling limits and missing coverage. Competitor comparison must use equivalent criteria and dates. Never fabricate review counts, negative sentiment or revenue impacts.

## Per-adapter acceptance
Test success, empty, restricted, rate limit, timeout, wrong business, duplicate, malicious content, unexpected schema and budget exhaustion. Add integration tests using fixtures; only label 'live tested' when actually called with authorized credentials.
