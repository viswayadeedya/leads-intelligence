# Definition of ready and phase exit criteria
Before coding a feature, identify: user job, screen state, data contract, trust risks, security risks, expected failure modes, measurable acceptance tests and cost limit. If missing, define them in repo; do not ask user for trivial choices.

## Phase 0: repo + mock
A runnable app with navigation, accessible mock report, synthetic evidence, no external credentials. Document commands and screenshots. Pass static checks and test suite.

## Phase 1: one live vertical slice
Manual business input → verified website fetch → bounded extraction → evidence → opportunity → reviewer approval → owner-safe report → editable outreach draft. All claims sourced; no auto-send. Security gates passed.

## Phase 2: discovery and selective enrichment
Places adapter, batch limits, duplicate handling, search discovery, manual social research. Cost accounting and source-specific failures visible.

## Phase 3: measurement
Outcome tracking, false-positive review, investigation economics, feedback from owner conversations. Only then decide on more integrations or self-serve tool.

## Stop/ask rules
Stop for paid API charges not preapproved, live credentials, public deployment, external communication, sensitive-data access, irreversible changes, or ambiguous legal rights. Otherwise continue autonomously and log decisions.
