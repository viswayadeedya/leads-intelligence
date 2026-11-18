# UX artifacts: route map, component inventory, five-task walkthrough

Date: 2026-11-18. Performed by the builder (Claude) driving the real app in a browser (dev mode on port 3210; one extra pass in production mode on port 3211). **This is a scripted walkthrough by the person who built the screens, not a usability test with the operator.** The "under 60 seconds with no instructions" goal in particular can only be judged by the operator. All data shown is synthetic.

Low-fidelity wireframes: `WIREFRAMES.md` (text wireframes, written before the UI code).

## Route map
| Route | Title | Primary action | State |
|---|---|---|---|
| `/login` | Sign in | Continue as local operator / Sign in | Built |
| `/` | Find a business worth helping | Start investigation | Built |
| `/discover` | Choose businesses to investigate | Add business; Investigate (per row) | Built for manual entry and synthetic examples. Automatic discovery, batch select and budget input are **not built** and say so on screen. |
| `/investigations` | Investigations | Start investigation | Built |
| `/investigations/[id]` | Investigating [business] | View evidence | Built: five stages, sources table, problems, unknowns, Retry failed source, Stop investigation, identity and duplicate decisions |
| `/evidence` | What we actually found | Review evidence (per row) | Built |
| `/evidence/[runId]` | What we actually found | Accept / Reject / Needs verification | Built: two panes, six filters, manual observation form |
| `/reports` | Reports | Open (per row) | Built |
| `/reports/[id]` | Opportunity report: [business] | Approve report | Built: seven sections in the specified order, claim-level source drawers, internal watermark |
| `/reports/[id]?view=owner` | same, owner preview | Approve owner version | Built: redaction summary, exact export text, download after approval |
| `/outreach` | Start a relevant conversation | Approve this exact text | Built: copy-only. No send capability exists. |
| `/outcomes` | Did our research create a conversation? | none | **Not built.** Page says so. |
| `/settings` | Control sources, cost and privacy | none (read-only) | Built read-only, plus the audit trail |
| `/api/investigations/[id]` | JSON status, cost, errors | | Built (GET) |
| `/api/reports/[id]/export` | approved owner Markdown | | Built (GET) |

Not built from the blueprint: global search; persisted filters; destructive-action undo (there are no delete actions yet).

## Component inventory (`src/components/`)
`PageHeader` (breadcrumb, title, subtitle, badges, actions) · `Badge` / `StatusBadge` (status always in words) · `MockBadge` · `NoticeBanner` (result of the last action, with next step) · `Empty` · `Field` (label + hint) · `Caveats` · `Time` (always `YYYY-MM-DD HH:MM UTC`) · `CopyButton` (the only client-side component). Page-local: `SourceDrawer`, `Claim`, `Body` in the report page.

## Universal states: what exists
Empty (every list), partial success (investigation, evidence, report callouts), source restricted, recoverable error (notice with next action), fatal error (`error.tsx`), not found, loading (`loading.tsx`), mock-mode warning (banner on every page plus per-run and per-report callouts). **Not implemented:** a distinct "stale data" page state (staleness is shown per observation), and live progress during a run (mock runs finish inside one request, so there is no in-flight view).

## Five-task walkthrough
| # | Task (from INTERACTION_AND_COPY.md) | Result | What happened |
|---|---|---|---|
| 1 | Start a mock investigation in under 60 seconds with no instructions | Completed in 3 clicks. Time-to-complete for a first-time human **not measured**. | Sign in → Start investigation → Investigate (on an example). Landed on the investigation page with status and next action. Screenshots 01, 02, 03. |
| 2 | Find the original evidence behind any report claim in at most two interactions | Completed in 1 interaction | "View source" under the claim opens URL, retrieval time, access status, confidence rationale and evidence ID in place. A second click opens it in the evidence desk. Screenshot 05. |
| 3 | Identify a restricted source and understand what it does *not* mean | Completed | The 403 example shows "Access restricted" on the Identity and Website stages, "Nothing can be concluded about the business from this source", an unknown labelled "This is not a finding about the business", and "Not retried: restricted sources are respected, not worked around." Screenshot 07. |
| 4 | Reject a false claim; confirm report changes and audit trail updates | Completed | Rejecting without a note is refused with a reason. With a note: the observation shows Rejected, the report's executive finding changes to "no evidence-backed observation", the opportunity disappears, and the audit trail shows `evidence.rejected` (human, with the note) followed by `opportunity.status_changed` (system). Screenshot 06. |
| 5 | Preview the owner-safe report; verify restricted source material is absent | Completed | In the private-group example the owner preview includes 1 finding, lists 1 withheld finding with the reason, and the page text and export text contain neither the note nor its marker string (checked in the DOM and in the downloaded response). Screenshots 08, 09. |

Also exercised: outreach draft → approve exact text → "Mark manually sent" disabled for a fictional business (screenshot 10); identity block with operator confirmation (11); timed-out page → Retry failed source → complete (12); prompt-injection example under the production Content-Security-Policy with no console errors (13).

## Issues found during the walkthrough
| Issue | Severity | Status |
|---|---|---|
| A form submitted before the page's JavaScript loaded was refused with raw JSON `403`. Cause: `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on plain form posts, which the CSRF check refuses. | High (any slow page load) | Fixed: policy is now `same-origin`; refusals to people render a readable page. Re-tested. |
| Horizontal scrolling at phone width (538px content in a 375px viewport) on the evidence desk | Medium | Fixed (grid children may shrink). Six pages re-measured at 375px: no overflow. |
| After a review decision the desk stayed on the decided item, costing an extra click per observation | Medium | Fixed: moves to the next observation needing a decision. Re-tested in the browser: after Accept, the next "Needs review" item was selected and the notice said so. |
| Synthetic examples were below the fold on Discover, hurting task 1 | Medium | Fixed: callout at the top links to them; Home empty state links there too. |
| Journey row said "No source for this step was inspected" after the reviewer rejected that step's observation | Medium (inaccurate) | Fixed: now says the observation was not accepted in review. |
| Audit trail credited automatic consequences (run finished, claim invalidated, fixture note seeded) to the human | Medium (audit accuracy) | Fixed: recorded as `system`. |
| Markdown export escaped every parenthesis, hurting readability | Low | Fixed. |
| Top navigation wraps to three rows on a phone | Low | Open. Desktop-first; acceptable for now. |
| Form inputs are labelled by wrapping `<label>` elements; one automated tree view did not show an accessible name for the note field | Unknown | Open. Needs a screen-reader check. |

## Accessibility: what was and was not checked
Present by construction: skip link, visible focus outline, semantic headings/tables/landmarks, status in words (never color alone), 44px minimum control height, `prefers-reduced-motion` respected (there are no animations), no content rendered from raw HTML. **Not done:** contrast measurement, screen-reader pass, full keyboard-only pass, WCAG 2.2 AA audit. No compliance is claimed.

## Screenshots (`docs/ux/screenshots/`, synthetic data only)
01 sign-in · 02 home (empty) · 03 investigation ready for review · 04 evidence desk · 05 report source drawer · 06 evidence rejected · 07 source restricted (403) · 08 restricted note, internal view · 09 owner preview with redaction summary · 10 outreach draft · 11 blocked for identity · 12 retry failed source · 13 prompt-injection text shown inert (production CSP).
Screenshots 01–12 predate the fixes above; 13 was taken after them.
