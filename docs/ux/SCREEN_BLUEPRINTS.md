# Screen-by-screen contract

## 1. Home `/`
Title: **Find a business worth helping**. Subtitle: **Investigate real customer friction before pitching solutions.** Primary action: **Start investigation**. Secondary: **Review findings**. Show counts of investigated, evidence-backed opportunities, awaiting review, owner responses; no vanity charts. Empty state: 'No investigations yet — start with a business name or website.'

## 2. Discover `/discover`
Title: **Choose businesses to investigate**. Inputs: service (HVAC default), city/region, number of businesses, budget cap. Manual URL/name entry always available. Primary: **Find businesses**. Show discovery provider, freshness, duplicates and matching confidence. Never automatically research hundreds. Batch select + **Investigate selected**.

## 3. Investigation `/investigations/[id]`
Title: **Investigating [business]**. Show five plain stages: Identity → Website → Public signals → Evidence review → Report. Each stage: pending/running/complete/partial/restricted/failed. Source details expandable. **Stop investigation** and **Retry failed source**. A visible 'This run used mock data' banner when relevant. Do not imply that a long-running job succeeded.

## 4. Evidence desk `/evidence/[runId]`
Title: **What we actually found**. Two-pane layout: observations left, source details right. Filters: verified, needs review, restricted, contradictory. Every observation shows evidence ID, original URL, retrieval time, exact observed fact, confidence rationale, and permission/storage class. Actions: **Accept**, **Reject**, **Needs verification**. Contradictory evidence cannot be hidden.

## 5. Opportunity report `/reports/[id]`
Title: **Opportunity report: [business]**. Sections in order: executive finding, observed customer journey, evidence cards, unknowns/alternative explanations, owner questions, possible improvements, methodology/limitations. Claim-level source buttons. Internal watermark until approved. **Preview as owner** removes restricted evidence and internal notes. **Approve report** is separate from **Approve outreach**.

## 6. Outreach `/outreach`
Title: **Start a relevant conversation**. Show recipient/identity verification, one specific observation, proposed diagnostic, draft email, preview, and explicit send method. MVP: copy/export only; no autonomous sending. Never suggest a prospect is losing money without proof.

## 7. Outcomes `/outcomes`
Title: **Did our research create a conversation?**. Track approached, responded, diagnostic requested, meeting, pilot, paid client, lost/no response. Manual outcome entry. Show denominator and time window. Don't claim causality from one reply.

## 8. Settings `/settings`
Title: **Control sources, cost and privacy**. Clearly separate mock/live, API credential health (never show values), budgets, retention, export/delete, source enablement, and permission status. Live mode requires deliberate confirmation and passing release gates.

## Global navigation
Home | Discover | Investigations | Evidence | Reports | Outreach | Outcomes | Settings. Global search and breadcrumb. Keyboard focus and accessible navigation. Consistent date/time locale and clear timezone.
