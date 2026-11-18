// Reasoner -> verifier -> opportunities. Re-runnable: called after collection,
// after manual evidence is added, and after every review decision.

import { findCaseByKey } from '@/fixtures/golden';
import { appendAudit, getOwned, type Ctx } from '../context';
import { newId } from '../ids';
import { logEvent } from '../log';
import { MockRuleReasoner, SERVICE_CATALOG, type Reasoner, type ReasonerInput } from '../reasoning/reasoner';
import { verifyReasonerOutput, type VerifyOutcome } from '../reasoning/verifier';
import type { Business, Db, Evidence, Opportunity, OpportunityStatus } from '../types';
import { syncReportAfterChange } from './reports';

export function activeEvidence(db: Db, runId: string): Evidence[] {
  return db.evidence.filter((e) => e.runId === runId && !e.supersededBy);
}

/** Evidence IDs that disagree with another observation on the same topic. Never hidden. */
export function contradictoryIds(evidence: Evidence[]): Set<string> {
  const out = new Set<string>();
  const byTopic = new Map<string, Evidence[]>();
  for (const e of evidence) {
    if (!e.topic || !e.stance || e.stance === 'neutral' || e.verificationStatus === 'rejected' || e.identityMatchStatus !== 'confirmed') continue;
    byTopic.set(e.topic, [...(byTopic.get(e.topic) ?? []), e]);
  }
  for (const group of byTopic.values()) {
    const hasProblem = group.some((e) => e.stance === 'reports_problem');
    const hasPositive = group.some((e) => e.stance === 'reports_positive');
    if (hasProblem && hasPositive) for (const e of group) out.add(e.id);
  }
  return out;
}

export function evaluateOpportunity(opp: Opportunity, evidenceById: Map<string, Evidence>): OpportunityStatus {
  let needsReview = false;
  for (const id of opp.evidenceIds) {
    const ev = evidenceById.get(id);
    if (!ev || ev.supersededBy || ev.verificationStatus === 'rejected' || ev.identityMatchStatus !== 'confirmed') return 'invalidated';
    if (ev.verificationStatus !== 'accepted') needsReview = true;
  }
  return needsReview ? 'needs_review' : 'supported';
}

function reasonerFor(ctx: Ctx, business: Business): Reasoner {
  // Only bundled synthetic cases can switch on the deliberately hostile mock.
  if (ctx.transport.synthetic && business.synthetic && business.fixtureKey && findCaseByKey(business.fixtureKey)?.hostileReasoner) {
    return new MockRuleReasoner({ hostile: true });
  }
  return ctx.reasoner;
}

function oppKey(title: string, evidenceIds: string[]): string {
  return `${title}|${[...evidenceIds].sort().join(',')}`;
}

export async function analyzeRun(ctx: Ctx, runId: string): Promise<{ outputInvalid: boolean }> {
  const snap = ctx.store.snapshot();
  const run = getOwned(snap.runs, runId, ctx.actor, 'Investigation');
  const business = getOwned(snap.businesses, run.businessId, ctx.actor, 'Business');
  const evidence = activeEvidence(snap, runId);
  const reasoner = reasonerFor(ctx, business);

  const input: ReasonerInput = {
    business: { displayName: business.displayName, city: business.city, state: business.state },
    serviceCatalog: SERVICE_CATALOG,
    evidence: evidence
      .filter((e) => e.identityMatchStatus === 'confirmed' && e.verificationStatus !== 'rejected' && e.evidenceType !== 'instruction_like_text')
      .map((e) => ({
        id: e.id,
        type: e.evidenceType,
        polarity: e.polarity,
        observation: e.observation,
        observedAt: e.observedAt,
        confidence: e.confidence,
        caveats: e.caveats,
        topic: e.topic,
        stance: e.stance,
        pagesInspected: Array.isArray(e.locator.pagesInspected) ? e.locator.pagesInspected.length : null,
      })),
  };

  let outcome: VerifyOutcome;
  try {
    const raw = await reasoner.propose(input);
    outcome = verifyReasonerOutput(raw, {
      business,
      runId,
      evidenceById: new Map(evidence.map((e) => [e.id, e])),
      sourceRecordsById: new Map(snap.sourceRecords.filter((r) => r.runId === runId).map((r) => [r.id, r])),
      runSourceRecords: snap.sourceRecords.filter((r) => r.runId === runId),
      now: ctx.now(),
      staleAfterDays: ctx.config.staleAfterDays,
    });
  } catch {
    outcome = {
      accepted: [],
      rejections: [{ code: 'model_invalid_output', message: 'The reasoner failed. No claims were accepted; evidence can still be reviewed manually.', proposalTitle: '(whole output)' }],
      outputInvalid: true,
    };
  }

  ctx.store.transact((db) => {
    const now = ctx.now().toISOString();
    for (const rejection of outcome.rejections) {
      const seen = db.verifierRejections.some((r) => r.runId === runId && r.code === rejection.code && r.proposalTitle === rejection.proposalTitle);
      if (seen) continue;
      db.verifierRejections.push({ id: newId('rej'), ownerId: ctx.actor.userId, runId, at: now, ...rejection });
      appendAudit(db, ctx, 'verifier.rejected_claim', 'run', runId, `${rejection.code}: ${rejection.proposalTitle}`, 'system');
      logEvent({ action: 'verifier.reject', result: 'rejected', runId, code: rejection.code });
    }

    const existing = db.opportunities.filter((o) => o.runId === runId);
    const acceptedKeys = new Set<string>();
    for (const { proposal, caveats } of outcome.accepted) {
      const key = oppKey(proposal.title, proposal.evidence_ids);
      acceptedKeys.add(key);
      const found = existing.find((o) => oppKey(o.title, o.evidenceIds) === key);
      if (found) {
        found.caveats = caveats;
        continue;
      }
      db.opportunities.push({
        id: newId('opp'),
        ownerId: ctx.actor.userId,
        runId,
        title: proposal.title,
        observedFact: proposal.observed_fact,
        interpretation: proposal.interpretation,
        alternativeExplanations: proposal.alternative_explanations,
        ownerQuestion: proposal.owner_question,
        possibleFix: proposal.possible_fix,
        evidenceIds: [...new Set(proposal.evidence_ids)],
        confidence: proposal.confidence,
        caveats,
        status: 'needs_review',
        decision: 'pending',
        decisionReason: null,
        createdAt: now,
      });
    }

    const evidenceById = new Map(activeEvidence(db, runId).map((e) => [e.id, e]));
    for (const opp of db.opportunities.filter((o) => o.runId === runId)) {
      // A claim the verifier no longer accepts cannot stay alive.
      const stillAccepted = outcome.outputInvalid || acceptedKeys.has(oppKey(opp.title, opp.evidenceIds));
      const next = stillAccepted ? evaluateOpportunity(opp, evidenceById) : 'invalidated';
      if (next !== opp.status) {
        opp.status = next;
        appendAudit(db, ctx, 'opportunity.status_changed', 'opportunity', opp.id, `Now ${next}.`, 'system');
      }
    }
    syncReportAfterChange(db, ctx, runId);
  });

  return { outputInvalid: outcome.outputInvalid };
}
