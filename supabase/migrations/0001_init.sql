-- Opportunity Intelligence: initial schema with owner-scoped row-level security.
--
-- STATUS: NOT APPLIED, NOT TESTED. Written to mirror src/lib/types.ts so the
-- JSON-file store can later be replaced by Postgres. No Supabase project or
-- local Postgres was available when this was written. Before live mode it
-- must be applied to a development project and the RLS negative tests in
-- docs/security/SECURITY_PROTOCOL.md (SELECT/INSERT/UPDATE/DELETE as another
-- user and as anon) must pass. Do not treat this file as evidence of RLS.

create extension if not exists pgcrypto;

create table businesses (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  normalized_name text not null,
  display_name text not null check (char_length(display_name) <= 120),
  domain text,
  phone text,
  address text,
  city text not null,
  state text not null check (char_length(state) = 2),
  category text not null default 'hvac',
  external_ids jsonb not null default '{}',
  identity_status text not null check (identity_status in ('unverified','confirmed','ambiguous','confirmed_by_operator')),
  identity_notes jsonb not null default '[]',
  synthetic boolean not null default false,
  fixture_key text,
  possible_duplicate_of text references businesses(id),
  duplicate_resolution text check (duplicate_resolution in ('unresolved','kept_separate','marked_duplicate')),
  created_at timestamptz not null default now()
);

create table investigation_runs (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  business_id text not null references businesses(id),
  status text not null check (status in ('queued','resolving_identity','collecting','analyzing','verifying','review_ready','blocked','partial','failed','canceled')),
  stages jsonb not null,
  started_at timestamptz,
  finished_at timestamptz,
  mode text not null check (mode in ('mock','live')),
  query_scope jsonb not null,
  robots jsonb not null,
  budget_exhausted boolean not null default false,
  fixture_notes_seeded boolean not null default false,
  budget_cents integer not null check (budget_cents >= 0),
  spent_cents integer not null default 0 check (spent_cents >= 0 and spent_cents <= budget_cents),
  request_cap integer not null check (request_cap > 0),
  requests_used integer not null default 0 check (requests_used >= 0 and requests_used <= request_cap),
  retries_used integer not null default 0,
  model_version text not null,
  error_summary jsonb not null default '[]',
  unknowns jsonb not null default '[]',
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create table source_records (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  run_id text not null references investigation_runs(id),
  business_id text not null references businesses(id),
  source_type text not null check (source_type in ('website','manual_observation')),
  source_url text,
  provider text not null,
  retrieved_at timestamptz not null,
  access_status text not null check (access_status in ('ok','restricted','unavailable','error')),
  access_detail text not null,
  permitted_storage_class text not null check (permitted_storage_class in ('PUBLIC_BUSINESS','RESTRICTED_SOURCE','PERSONAL')),
  query_context jsonb not null default '{}',
  checksum text,
  notes text not null default '',
  attempts integer not null default 1,
  retryable boolean not null default false,
  extracted jsonb,           -- bounded derived facts only; never raw HTML, cookies or credentials
  synthetic boolean not null default false
);
create unique index source_records_one_per_page on source_records (run_id, source_url) where source_type = 'website';

create table evidence (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  run_id text not null references investigation_runs(id),
  business_id text not null references businesses(id),
  source_record_ids text[] not null check (cardinality(source_record_ids) >= 1),
  evidence_type text not null,
  polarity text not null check (polarity in ('presence','absence','neutral')),
  observation text not null check (char_length(observation) <= 600),
  supporting_excerpt text check (char_length(supporting_excerpt) <= 240),
  locator jsonb not null default '{}',
  observed_at timestamptz not null,
  identity_match_status text not null check (identity_match_status in ('confirmed','uncertain','mismatch')),
  verification_status text not null check (verification_status in ('needs_review','accepted','rejected','needs_verification')),
  review_note text,
  sensitivity text not null check (sensitivity in ('public','restricted','personal')),
  confidence text not null check (confidence in ('low','medium','high')),
  confidence_rationale text not null,
  caveats text[] not null default '{}',
  topic text,
  stance text check (stance in ('reports_problem','reports_positive','neutral')),
  dedupe_key text not null,
  checksum text not null,
  superseded_by text,
  synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

create table opportunities (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  run_id text not null references investigation_runs(id),
  title text not null,
  observed_fact text not null,
  interpretation text not null,
  alternative_explanations jsonb not null check (jsonb_array_length(alternative_explanations) >= 1),
  owner_question text not null check (char_length(owner_question) > 0),
  possible_fix text not null,
  evidence_ids text[] not null check (cardinality(evidence_ids) >= 1),
  confidence text not null check (confidence in ('low','medium','high')),
  caveats text[] not null default '{}',
  status text not null check (status in ('needs_review','supported','invalidated')),
  decision text not null check (decision in ('pending','accepted','rejected')),
  decision_reason text,
  created_at timestamptz not null default now()
);

create table verifier_rejections (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  run_id text not null references investigation_runs(id),
  code text not null,
  message text not null,
  proposal_title text not null,
  at timestamptz not null default now()
);

create table reports (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  run_id text not null unique references investigation_runs(id),
  business_id text not null references businesses(id),
  version integer not null default 1,
  status text not null check (status in ('draft','evidence_review','approved_internal','approved_to_share')),
  approved_at timestamptz,
  approved_content_hash text,
  shared_at timestamptz,
  shared_snapshot text,
  shared_content_hash text,
  created_at timestamptz not null default now()
  -- no share_token column: there are no share links in the MVP
);

create table outreach_drafts (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  business_id text not null references businesses(id),
  report_id text not null references reports(id),
  report_version integer not null,
  opportunity_id text not null references opportunities(id),
  channel text not null check (channel = 'email'),
  subject text not null,
  body text not null,
  status text not null check (status in ('draft','approved','sent_manual')),
  approved_at timestamptz,
  approval_id text,
  copied_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table approvals (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  action text not null check (action = 'outreach_manual_send'),
  target_id text not null,
  recipient text not null,
  content_hash text not null,
  token_hash text not null unique,   -- the token itself is never stored
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table audit_events (
  id text primary key,
  owner_id uuid not null default auth.uid(),
  actor_kind text not null check (actor_kind in ('human','system','model')),
  action text not null,
  target_type text not null,
  target_id text not null,
  detail text not null check (char_length(detail) <= 300),
  at timestamptz not null default now()
);

-- Row-level security: deny by default, owner-only access on every table.
do $$
declare t text;
begin
  foreach t in array array['businesses','investigation_runs','source_records','evidence','opportunities','verifier_rejections','reports','outreach_drafts','approvals','audit_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('create policy %I on %I for select to authenticated using (owner_id = auth.uid())', t || '_select_own', t);
    execute format('create policy %I on %I for insert to authenticated with check (owner_id = auth.uid())', t || '_insert_own', t);
    if t <> 'audit_events' then
      execute format('create policy %I on %I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t || '_update_own', t);
      execute format('create policy %I on %I for delete to authenticated using (owner_id = auth.uid())', t || '_delete_own', t);
    end if;
  end loop;
end $$;
-- audit_events deliberately has no UPDATE or DELETE policy: append-only for application roles.
