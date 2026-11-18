# Data Model — Initial Tables

## businesses
id UUID PK; normalized_name; display_name; domain; phone nullable; address nullable; city; state; category; external_ids JSONB; identity_status; created_at.

## investigation_runs
id UUID PK; business_id FK; status; started_at; finished_at; mode (mock/live); query_scope JSONB; budget_cents; spent_cents; model_version; error_summary.

## source_records
id UUID PK; run_id FK; business_id FK; source_type; source_url; provider; retrieved_at; access_status (ok/restricted/unavailable/error); permitted_storage_class; query_context JSONB; checksum; notes. No storing authentication secrets or private session cookies.

## evidence
id UUID PK; source_record_id FK; business_id FK; evidence_type; observation; supporting_excerpt nullable; locator JSONB (page selector/search query/result reference); observed_at; identity_match_status; verification_status; sensitivity; created_at. Store excerpts only when permitted.

## opportunities
id UUID PK; run_id FK; title; observed_fact; interpretation; alternative_explanations JSONB; owner_question; possible_fix; evidence_ids UUID[]; confidence; status; created_at. Enforce at least one valid evidence_id for factual assertions.

## reports
id UUID PK; run_id FK; version; status; summary; limitations JSONB; approved_at nullable; share_token_hash nullable; created_at.

## outreach_drafts
id UUID PK; business_id FK; report_id FK; channel; subject; body; status (draft/approved/sent_manual); approved_at nullable; created_at.

## outcome_events
id UUID PK; business_id FK; outreach_draft_id nullable; event_type; occurred_at; notes; created_at.

## operational tables
adapter_runs (latency/cost/status); audit_events (actor/action/time); configuration (non-secret). Store secrets in environment or secret manager, not database plaintext.

## Access controls
Supabase RLS enabled by default; owner-scoped access for all tenant data; server-side service credentials never exposed to client. Owner-facing report sharing must exclude private/restricted evidence by default.
