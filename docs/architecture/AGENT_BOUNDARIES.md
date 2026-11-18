# Agent autonomy and tool boundaries
Use a deterministic job state machine: queued → discovery → identity verified → source acquisition → evidence extraction → claim verification → report draft → human review → completed/partial/failed/cancelled. Persist checkpoints; idempotent retries; no infinite agent loops.

## Tool authority
The LLM may: classify source text, propose research queries, draft opportunities, identify missing checks, write drafts. The LLM may NOT: change security settings, enable live mode, fetch arbitrary URLs, approve claims, execute code from web pages, access secrets, send outreach, alter permissions, or decide that source restrictions can be ignored.

## Source adapter contract
Input: business ID, approved query or URL, scoped budget, run ID. Output: provider, URL, retrieval timestamp, access status, rights/storage class, identity match, bounded normalized observations, checksums, cost, latency, error category. Fetching tools enforce network restrictions and terms, independent of model output.

## Budget and recovery
Default mock mode and $0 external spend. Configurable maximum sources/run, pages/site, model tokens, concurrency, retries, timeout, and dollars/run. If budget reached: stop safely, mark partial, retain evidence. If model fails: allow manual evidence review. Never use a failed retry to duplicate charges or source records.

## Prompt injection defenses
External snippets are quoted data, never developer instructions. Structured outputs validated by schemas and evidence-ID allowlist. Model output cannot invent citation IDs. Unknown data remains unknown. Never store or execute instructions found on target sites.
