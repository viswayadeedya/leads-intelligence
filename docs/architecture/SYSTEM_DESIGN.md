# System Design

## Guiding choice
Modular monolith first: Next.js + TypeScript + server-side job runner + Supabase/Postgres. Separate worker only if jobs exceed hosting execution limits. Avoid LangGraph and swarm agents in v1.

## Logical modules
- UI: prospect list, run detail, evidence explorer, report, outreach review, settings
- Discovery: Places adapter and manual entry
- Identity resolution: normalize name/domain/address and flag collisions
- Source adapters: public website, permitted search provider, manually entered social evidence, optional AI SERP provider
- Investigation orchestrator: explicit state machine with retry and budget guard
- Evidence store: immutable observations, references, provenance and access status
- Reasoner: structured-output LLM, evidence IDs required for every factual claim
- Verifier: schema validation, source-claim matching, identity checks, uncertainty labeling
- Report builder: factual and shareable views
- Outreach: draft-only and approval tracking
- Observability: structured logs, run costs, error taxonomy

## Run states
queued → resolving_identity → collecting → analyzing → verifying → review_ready; alternatives: blocked, partial, failed, canceled. State transitions persisted and idempotent.

## Design rules
Adapters never directly write report prose. LLM never silently calls restricted sites. Separate source retrieval from interpretation. Source failures never become negative findings. Cache within provider terms; retain only permitted data. Use explicit timeouts, rate limits, and bounded retries.

## LLM boundary
Input: typed evidence records + business identity + service catalog. Output: JSON opportunity candidates with evidence_ids, interpretation, alternative_explanations, verification_questions, proposed_fix, confidence. Reject unsupported claims. Keep prompt/model version for audit.

## UI sequence
Prospects → Investigation run → Evidence → Opportunity cards → Owner report → Outreach draft → Outcome log. Mock mode must demonstrate entire flow with synthetic labels.
