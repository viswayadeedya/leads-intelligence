import { listOwned, type Ctx } from '../context';
import type { AuditEvent } from '../types';

export type HomeCounts = {
  investigated: number;
  evidenceBacked: number;
  awaitingReview: number;
  blockedRuns: number;
};

/** Counts for the home screen. Plain tallies of stored rows; no estimates, no scores. */
export function getHomeCounts(ctx: Ctx): HomeCounts {
  const db = ctx.store.snapshot();
  const runs = listOwned(db.runs, ctx.actor);
  const runIds = new Set(runs.map((r) => r.id));
  return {
    investigated: runs.filter((r) => r.status === 'review_ready' || r.status === 'partial').length,
    evidenceBacked: db.opportunities.filter((o) => runIds.has(o.runId) && o.status === 'supported' && o.decision === 'accepted').length,
    awaitingReview: db.evidence.filter((e) => runIds.has(e.runId) && !e.supersededBy && e.verificationStatus === 'needs_review').length,
    blockedRuns: runs.filter((r) => r.status === 'blocked').length,
  };
}

export function listAudit(ctx: Ctx, limit: number): AuditEvent[] {
  return listOwned(ctx.store.snapshot().auditEvents, ctx.actor)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
