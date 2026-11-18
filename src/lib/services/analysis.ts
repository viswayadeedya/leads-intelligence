// Reasoner -> verifier -> opportunities. Re-runnable: called after collection,
// after manual evidence is added, and after every review decision.

import { findCaseByKey } from '@/fixtures/golden';
import { appendAudit, getOwned, type Ctx } from '../context';
import { newId } from '../ids';
import { logEvent } from '../log';
import { MockRuleReasoner, SERVICE_CATALOG, type Proposal, type Reasoner, type ReasonerEvidence, type ReasonerInput } from '../reasoning/reasoner';
import { verifyReasonerOutput, type Rejection, type VerifiedProposal } from '../reasoning/verifier';
import type { Business, Db, Evidence, Opportunity, OpportunityStatus, SourceRecord } from '../types';
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

/**
 * True when an observation may be shown to the reasoner while it writes text
 * that could later reach a business owner: classified public, and every source
 * behind it is a PUBLIC_BUSINESS record. Review status is deliberately not
 * part of this; review happens after reasoning.
 */
export function isPublicContext(e: Evidence, sources: Map<string, SourceRecord>): boolean {
  if (e.sensitivity !== 'public') return false;
  if (e.sourceRecordIds.length === 0) return false;
  return e.sourceRecordIds.every((id) => sources.get(id)?.permittedStorageClass === 'PUBLIC_BUSINESS');
}

function toReasonerEvidence(e: Evidence): ReasonerEvidence {
  return {
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
  };
}

const proposalText = (p: Proposal) => JSON.stringify([p.title, p.observed_fact, p.interpretation, p.alternative_explanations, p.owner_question, p.possible_fix]);
const storedText = (o: Opportunity) => JSON.stringify([o.title, o.observedFact, o.interpretation, o.alternativeExplanations, o.ownerQuestion, o.possibleFix]);

type Context = NonNullable<Opportunity['reasonedFrom']>;

/**
 * Reasoning runs in two separate contexts so that restricted material cannot
 * be paraphrased into a claim an owner will read:
 *
 *   public_only         the reasoner sees only public observations. Only these
 *                       claims can ever appear in an owner report or outreach.
 *   includes_restricted the reasoner sees everything. A claim is kept from this
 *                       pass only if it cites restricted evidence; it stays internal.
 *
 * The second call is made only when restricted evidence exists.
 */
export async function analyzeRun(ctx: Ctx, runId: string): Promise<{ outputInvalid: boolean }> {
  const snap = ctx.store.snapshot();
  const run = getOwned(snap.runs, runId, ctx.actor, 'Investigation');
  const business = getOwned(snap.businesses, run.businessId, ctx.actor, 'Business');
  const evidence = activeEvidence(snap, runId);
  const reasoner = reasonerFor(ctx, business);
  const runRecords = snap.sourceRecords.filter((r) => r.runId === runId);
  const sources = new Map(runRecords.map((r) => [r.id, r]));

  const admissible = evidence.filter((e) => e.identityMatchStatus === 'confirmed' && e.verificationStatus !== 'rejected' && e.evidenceType !== 'instruction_like_text');
  const publicSet = admissible.filter((e) => isPublicContext(e, sources));
  const publicIds = new Set(publicSet.map((e) => e.id));

  const accepted: { item: VerifiedProposal; context: Context }[] = [];
  const rejections: Rejection[] = [];
  let outputInvalid = false;

  const pass = async (shown: Evidence[], citable: Evidence[], context: Context): Promise<void> => {
    const input: ReasonerInput = {
      business: { displayName: business.displayName, city: business.city, state: business.state },
      serviceCatalog: SERVICE_CATALOG,
      evidence: shown.map(toReasonerEvidence),
    };
    try {
      const raw = await reasoner.propose(input);
      const outcome = verifyReasonerOutput(raw, {
        business,
        runId,
        // Only evidence this pass was allowed to cite is admissible.
        evidenceById: new Map(citable.map((e) => [e.id, e])),
        sourceRecordsById: sources,
        runSourceRecords: runRecords,
        now: ctx.now(),
        staleAfterDays: ctx.config.staleAfterDays,
      });
      rejections.push(...outcome.rejections);
      if (outcome.outputInvalid) outputInvalid = true;
      for (const item of outcome.accepted) {
        const citesRestricted = item.proposal.evidence_ids.some((id) => !publicIds.has(id));
        // A claim citing only public evidence must come from the public-only
        // pass. The same claim written with restricted material in view is dropped.
        if (context === 'includes_restricted' && !citesRestricted) continue;
        accepted.push({ item, context });
      }
    } catch {
      outputInvalid = true;
      rejections.push({ code: 'model_invalid_output', message: 'The reasoner failed. No claims were accepted; evidence can still be reviewed manually.', proposalTitle: '(whole output)' });
    }
  };

  // In the public pass, restricted evidence cannot be cited at all: to the
  // verifier it does not exist.
  await pass(publicSet, evidence.filter((e) => isPublicContext(e, sources)), 'public_only');
  if (admissible.length > publicSet.length) await pass(admissible, evidence, 'includes_restricted');

  ctx.store.transact((db) => {
    const now = ctx.now().toISOString();
    for (const rejection of rejections) {
      const seen = db.verifierRejections.some((r) => r.runId === runId && r.code === rejection.code && r.proposalTitle === rejection.proposalTitle);
      if (seen) continue;
      db.verifierRejections.push({ id: newId('rej'), ownerId: ctx.actor.userId, runId, at: now, ...rejection });
      appendAudit(db, ctx, 'verifier.rejected_claim', 'run', runId, `${rejection.code}: ${rejection.proposalTitle}`, 'system');
      logEvent({ action: 'verifier.reject', result: 'rejected', runId, code: rejection.code });
    }

    const existing = db.opportunities.filter((o) => o.runId === runId);
    const acceptedKeys = new Set<string>();
    for (const { item, context } of accepted) {
      const { proposal, caveats } = item;
      const key = oppKey(proposal.title, proposal.evidence_ids);
      if (acceptedKeys.has(key)) continue;
      acceptedKeys.add(key);
      const found = existing.find((o) => oppKey(o.title, o.evidenceIds) === key);
      if (found) {
        found.caveats = caveats;
        if (context === 'includes_restricted') {
          found.reasonedFrom = 'includes_restricted';
        } else if (found.reasonedFrom !== 'public_only' && storedText(found) === proposalText(proposal)) {
          // Only marked shareable when the stored wording is exactly what the
          // public-only pass wrote. Different wording keeps its earlier, stricter mark.
          found.reasonedFrom = 'public_only';
        }
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
        reasonedFrom: context,
        createdAt: now,
      });
    }

    const evidenceById = new Map(activeEvidence(db, runId).map((e) => [e.id, e]));
    for (const opp of db.opportunities.filter((o) => o.runId === runId)) {
      // A claim the verifier no longer accepts cannot stay alive.
      const stillAccepted = outputInvalid || acceptedKeys.has(oppKey(opp.title, opp.evidenceIds));
      const next = stillAccepted ? evaluateOpportunity(opp, evidenceById) : 'invalidated';
      if (next !== opp.status) {
        opp.status = next;
        appendAudit(db, ctx, 'opportunity.status_changed', 'opportunity', opp.id, `Now ${next}.`, 'system');
      }
    }
    syncReportAfterChange(db, ctx, runId);
  });

  return { outputInvalid };
}
