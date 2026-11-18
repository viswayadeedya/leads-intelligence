# Operations runbook for a solo founder

## Local setup
Install supported Node LTS, package manager, Supabase local or hosted development project. Copy .env.example to untracked .env.local; mock mode must run without credentials. Document exact commands in README once implementation exists. Never claim commands work until executed.

## Daily routine
1. Check yesterday's failed/partial runs and budgets.
2. Start a small batch, inspect accepted findings.
3. Approve or reject evidence and owner-safe report.
4. Copy outreach draft and manually send if desired.
5. Log replies, objections and confirmed owner facts.

## Diagnostics
Every job has ID, phase, last success, error type, retries, time spent and spend. UI offers safe retry or cancellation. Errors: access_denied, source_unavailable, rate_limited, identity_ambiguous, extraction_failed, model_invalid_output, budget_exceeded, security_blocked.

## Backups and recovery
Document restore procedure and test it with synthetic data. Retention policy for logs, source metadata, manually entered social notes, and exports. Store audit events without sensitive payloads. Disable a compromised source adapter quickly.

## Incident response
On suspected leak: disable affected keys/integration, preserve minimal logs, rotate credentials, assess scope, purge exposed exports, document timeline and notification obligations. No auto-upload of secrets to issue trackers or model prompts.
