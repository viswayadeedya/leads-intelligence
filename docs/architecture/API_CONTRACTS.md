# API and Adapter Contracts

## Core HTTP endpoints (proposed)
- `POST /api/businesses` manual entry
- `GET /api/businesses` list/filter
- `POST /api/discovery` category, location, limit, provider
- `POST /api/investigations` business_id, scope, budget_cents, mode
- `GET /api/investigations/:id` status, cost, errors
- `GET /api/investigations/:id/evidence`
- `GET /api/investigations/:id/opportunities`
- `POST /api/reports/:id/approve` explicit operator approval
- `POST /api/outreach/draft` generates draft only
- `POST /api/manual-evidence` validated human research note

## Source adapter interface (conceptual TypeScript)
```ts
interface SourceAdapter {
  id: string;
  supports(input: InvestigationContext): boolean;
  collect(input: InvestigationContext, budget: RequestBudget): Promise<SourceCollectionResult>;
}
type SourceCollectionResult = {
  status: 'ok'|'partial'|'restricted'|'unavailable'|'error';
  records: SourceRecord[];
  evidence: EvidenceCandidate[];
  costCents: number;
  errors: {code: string; message: string}[];
};
```

## Structured LLM output
```json
{"opportunities":[{"title":"...","observed_fact":"...","evidence_ids":["uuid"],"interpretation":"...","alternative_explanations":["..."],"owner_question":"...","possible_fix":"...","confidence":"low|medium|high"}]}
```

## Invariants
Never accept unsupported evidence_ids. Every live record has a retrieval timestamp. API returns `restricted` distinctly from `not_found`. External writes require separate human-approved workflows and are out of scope for v1.
