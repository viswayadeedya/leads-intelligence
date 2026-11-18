# UX constitution — one operator, zero confusion
Audience: one founder operating the tool daily, not a public SaaS audience. Prioritize speed, legibility, traceability and trust over animations and visual spectacle.

## Non-negotiables
- Every screen must answer: Where am I? What can I do? What happened? What is next? What is uncertain?
- Use plain-English screen titles, one primary action per screen, clear secondary actions, visible status and timestamps.
- Never show an unexplained numeric score, unsupported estimate, or fake activity. Mock data must have a conspicuous MOCK label.
- Never bury source links. Each claim has a source drawer, observed timestamp, source access status, and confidence rationale.
- Distinguish `Not checked`, `Checked; not found`, `Access restricted`, `Error`, and `Verified`; they are not synonyms.
- Support keyboard navigation, focus indicators, readable contrast, accessible labels, 44px-ish touch targets where appropriate, responsive layout, and reduced motion. Aim for WCAG 2.2 AA; verify rather than claiming compliance.
- No dark patterns, mystery icons, modal mazes, infinite spinners or empty dashboards. Use progressive disclosure for technical details.
- Never require a human to copy-paste between AI agents. All actionable context belongs in repository files and UI.

## Design defaults
Desktop-first, responsive down to phone. Neutral palette, restrained accent color, generous whitespace, system font, 8px spacing scale, consistent badges only for meaningful status. Tables for batches, cards for findings, drawers for evidence, guided steps for complex tasks. Persist filters and drafts. Provide undo/confirmation for destructive operations.

## Universal UI states
For every page implement: initial/empty, loading with progress, partial success, success, source restricted, recoverable error, fatal error, stale data, and mock-mode warning. Provide specific next action, never 'Something went wrong' alone.

## Required design artifacts
Create low-fidelity wireframes before UI code. Keep component inventory, route map, annotated screenshots and a 5-task usability walkthrough in docs/ux/. Do not spend a day polishing before the first end-to-end test.
