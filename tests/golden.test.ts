// Golden set (docs/quality/EVALUATION_HARNESS.md) and the evidence-integrity
// adversarial tests from docs/quality/ACCEPTANCE_TESTS.md, run through the real
// pipeline: fixture transport -> extraction -> evidence -> reasoner -> verifier.
// All data is synthetic.

import { describe, expect, it } from 'vitest';
import { GOLDEN_CASES, MIXED_COMMENTS_TITLE, NO_ONLINE_PATH_TITLE, SINGLE_COMMENT_TITLE } from '@/fixtures/golden';
import { confirmIdentity, loadGoldenCase, resolveDuplicate } from '@/lib/services/businesses';
import { getEvidenceDesk, reviewEvidence } from '@/lib/services/evidence';
import { getRunDetail, resumeInvestigation, retryFailedSources, startInvestigation } from '@/lib/services/investigations';
import { activeEv, liveOpps, makeCtx, runGolden } from './helpers';

describe('golden set: expected outcome per case', () => {
  it('has at least 12 cases', () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(12);
  });

  it.each(GOLDEN_CASES.map((c) => [c.key, c] as const))('%s', async (_key, golden) => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, golden.key);
    expect(run.status).toBe(golden.expected.runStatus);
    expect(liveOpps(db, run.id).map((o) => o.title).sort()).toEqual([...golden.expected.opportunityTitles].sort());
    expect(db.verifierRejections.filter((r) => r.runId === run.id).length).toBeGreaterThanOrEqual(golden.expected.minVerifierRejections ?? 0);
    expect(run.mode).toBe('mock');
    expect(run.spentCents).toBe(0);
    // every opportunity cites only evidence from this run, for this business
    for (const opp of liveOpps(db, run.id)) {
      expect(opp.evidenceIds.length).toBeGreaterThan(0);
      expect(opp.alternativeExplanations.length).toBeGreaterThan(0);
      expect(opp.ownerQuestion.length).toBeGreaterThan(0);
      for (const id of opp.evidenceIds) {
        const ev = db.evidence.find((e) => e.id === id)!;
        expect(ev.runId).toBe(run.id);
        expect(ev.businessId).toBe(run.businessId);
        expect(ev.identityMatchStatus).toBe('confirmed');
      }
    }
    // all fixture-derived rows are labelled synthetic
    expect(db.sourceRecords.filter((s) => s.runId === run.id).every((s) => s.synthetic)).toBe(true);
    expect(activeEv(db, run.id).every((e) => e.synthetic)).toBe(true);
  });
});

describe('evidence integrity (acceptance tests 1-10)', () => {
  it('1. a comment about a different business cannot support an opportunity', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'baseline-phone-only');
    const wrong = activeEv(db, run.id).find((e) => e.identityMatchStatus === 'mismatch')!;
    expect(wrong).toBeDefined();
    expect(liveOpps(db, run.id).some((o) => o.evidenceIds.includes(wrong.id))).toBe(false);
    await expect(reviewEvidence(ctx, wrong.id, 'accepted', '')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('2. a 403 is "restricted" and never becomes a negative finding', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'site-403');
    const records = db.sourceRecords.filter((s) => s.runId === run.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.accessStatus).toBe('restricted');
    expect(activeEv(db, run.id)).toHaveLength(0);
    expect(run.unknowns.length).toBeGreaterThan(0);
    expect(run.unknowns[0]!.reason).toContain('not a finding about the business');
    expect(run.errorSummary.some((e) => e.code === 'access_denied')).toBe(true);
    expect(getRunDetail(ctx, run.id).canRetry).toBe(false); // restricted sources are not retried
  });

  it('2b. robots.txt disallow: pages are not requested at all', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'robots-disallow');
    expect(run.requestsUsed).toBe(1); // robots.txt only
    const home = db.sourceRecords.find((s) => s.runId === run.id)!;
    expect(home.accessStatus).toBe('restricted');
    expect(home.accessDetail).toContain('robots.txt');
    expect(activeEv(db, run.id)).toHaveLength(0);
  });

  it('3. inaccessible request page: no "no booking" assertion, an explicit unknown instead', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'booking-page-403');
    const ev = activeEv(db, run.id);
    expect(ev.some((e) => e.polarity === 'absence')).toBe(false);
    expect(ev.some((e) => e.evidenceType === 'phone_listed')).toBe(true);
    expect(run.unknowns.map((u) => u.question)).toContain('Whether the website offers online booking is unknown.');
    expect(run.unknowns[0]!.reason).toContain('does not mean it does not exist');
  });

  it('4. form missing on home page but present on contact page: finding reflects the deeper check', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'contact-form-deeper');
    const form = activeEv(db, run.id).find((e) => e.evidenceType === 'contact_form')!;
    expect(form.polarity).toBe('presence');
    expect(form.observation).toContain('/contact');
    expect(liveOpps(db, run.id)).toHaveLength(0);
  });

  it('5+6. invented statistic, nonexistent evidence ID and an "action" are rejected and logged', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'invented-revenue');
    const codes = db.verifierRejections.filter((r) => r.runId === run.id).map((r) => r.code).sort();
    expect(codes).toEqual(['unexpected_output_field', 'unknown_evidence_id', 'unsupported_quantified_impact']);
    const text = JSON.stringify(liveOpps(db, run.id));
    expect(text).not.toContain('4,200');
    expect(text).not.toContain('AI receptionist');
    expect(db.auditEvents.filter((a) => a.action === 'verifier.rejected_claim')).toHaveLength(3);
    // the "send_email" action did nothing: no drafts, no approvals
    expect(db.outreachDrafts).toHaveLength(0);
    expect(db.approvals).toHaveLength(0);
  });

  it('7. one complaint is labelled anecdotal with low confidence, and no pattern is claimed', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'outdated-site');
    const opp = liveOpps(db, run.id).find((o) => o.title === SINGLE_COMMENT_TITLE)!;
    expect(opp.confidence).toBe('low');
    expect(opp.caveats).toContain('anecdotal');
    expect(opp.interpretation).toContain('cannot show how often');
  });

  it('8. old evidence is flagged stale, dated, and not worded as current', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'outdated-site');
    const opp = liveOpps(db, run.id).find((o) => o.title === SINGLE_COMMENT_TITLE)!;
    expect(opp.caveats).toContain('stale');
    expect(opp.observedFact).toContain('2023-02-10');
    expect(/currently|right now|today/i.test(JSON.stringify(opp))).toBe(false);
    const desk = getEvidenceDesk(ctx, run.id);
    expect(desk.items.find((i) => i.evidence.evidenceType === 'customer_comment')!.stale).toBe(true);
    expect(activeEv(db, run.id).some((e) => e.evidenceType === 'stale_marker' && e.observation.includes('2019'))).toBe(true);
  });

  it('10. prompt injection in page HTML is inert source text', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'prompt-injection');
    const flagged = activeEv(db, run.id).find((e) => e.evidenceType === 'instruction_like_text')!;
    expect(flagged).toBeDefined();
    expect(flagged.sensitivity).toBe('restricted');
    expect(flagged.supportingExcerpt).toContain('ignore previous instructions');
    // hidden text and HTML comments were never extracted
    const all = JSON.stringify(db);
    expect(all).not.toContain('SYSTEM PROMPT OVERRIDE');
    expect(all).not.toContain('call send_email');
    // nothing happened: same single opportunity as the baseline, no outbound artifacts, nothing approved
    expect(liveOpps(db, run.id).map((o) => o.title)).toEqual([NO_ONLINE_PATH_TITLE]);
    expect(liveOpps(db, run.id)[0]!.evidenceIds).not.toContain(flagged.id);
    expect(db.outreachDrafts).toHaveLength(0);
    expect(db.approvals).toHaveLength(0);
    expect(db.reports.every((r) => r.status === 'evidence_review')).toBe(true);
    expect(db.businesses[0]!.identityStatus).toBe('confirmed');
    expect(db.auditEvents.some((a) => a.action.startsWith('outreach') || a.action.startsWith('report.approved'))).toBe(false);
  });

  it('contradictory comments are both kept visible and both cited', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'contradictory-comments');
    const desk = getEvidenceDesk(ctx, run.id);
    const flagged = desk.items.filter((i) => i.contradictory);
    expect(flagged).toHaveLength(2);
    const opp = liveOpps(db, run.id).find((o) => o.title === MIXED_COMMENTS_TITLE)!;
    expect(opp.evidenceIds.sort()).toEqual(flagged.map((f) => f.evidence.id).sort());
    expect(opp.confidence).toBe('low');
  });

  it('rejecting evidence invalidates the claim that depended on it and writes the audit trail', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'baseline-phone-only');
    const opp = liveOpps(db, run.id)[0]!;
    const absence = db.evidence.find((e) => opp.evidenceIds.includes(e.id) && e.evidenceType === 'booking_link')!;
    await reviewEvidence(ctx, absence.id, 'rejected', 'Booking widget loads through JavaScript; I saw it in a browser.');
    const after = ctx.store.snapshot();
    expect(liveOpps(after, run.id)).toHaveLength(0);
    expect(after.opportunities.find((o) => o.id === opp.id)!.status).toBe('invalidated');
    const actions = after.auditEvents.map((a) => a.action);
    expect(actions).toContain('evidence.rejected');
    expect(actions).toContain('opportunity.status_changed');
  });
});

describe('identity and duplicates', () => {
  it('same-name business in another city stops the run before any evidence is collected', async () => {
    const ctx = makeCtx();
    const { run, business, db } = await runGolden(ctx, 'same-name-other-city');
    expect(run.status).toBe('blocked');
    expect(business.identityStatus).toBe('ambiguous');
    expect(business.identityNotes.join(' ')).toContain('Lansing');
    expect(run.errorSummary[0]!.code).toBe('identity_ambiguous');
    expect(activeEv(db, run.id)).toHaveLength(0);
    expect(run.requestsUsed).toBe(2); // robots.txt + home page only
  });

  it('parent-company wording is flagged as ambiguous', async () => {
    const ctx = makeCtx();
    const { business } = await runGolden(ctx, 'parent-subsidiary');
    expect(business.identityStatus).toBe('ambiguous');
    expect(business.identityNotes.join(' ')).toContain('parent company');
  });

  it('operator can confirm identity (audited) and resume without refetching the home page', async () => {
    const ctx = makeCtx();
    const { run, business } = await runGolden(ctx, 'parent-subsidiary');
    await expect(resumeInvestigation(ctx, run.id)).resolves.toMatchObject({ status: 'blocked' });
    confirmIdentity(ctx, business.id, 'Called the listed number; same legal entity.');
    const resumed = await resumeInvestigation(ctx, run.id);
    expect(resumed.status).toBe('review_ready');
    const db = ctx.store.snapshot();
    expect(db.sourceRecords.filter((s) => s.runId === run.id && s.sourceUrl!.endsWith('.invalid/'))).toHaveLength(1);
    expect(db.sourceRecords.find((s) => s.runId === run.id && s.sourceUrl!.endsWith('.invalid/'))!.attempts).toBe(1);
    expect(db.auditEvents.some((a) => a.action === 'business.identity_confirmed_manually')).toBe(true);
    expect(liveOpps(db, run.id).map((o) => o.title)).toEqual([NO_ONLINE_PATH_TITLE]);
  });

  it('duplicate company with two domains is flagged, not merged, and cannot be investigated until resolved', async () => {
    const ctx = makeCtx();
    const [first, second] = loadGoldenCase(ctx, 'duplicate-two-domains');
    expect(first!.possibleDuplicateOf).toBeNull();
    expect(second!.possibleDuplicateOf).toBe(first!.id);
    expect(second!.duplicateResolution).toBe('unresolved');
    expect(ctx.store.snapshot().businesses).toHaveLength(2);
    const run = await startInvestigation(ctx, { businessId: second!.id });
    expect(run.status).toBe('blocked');
    expect(run.errorSummary[0]!.code).toBe('duplicate_unresolved');
    expect(run.requestsUsed).toBe(0);
    resolveDuplicate(ctx, second!.id, 'marked_duplicate', 'Same phone and address.');
    await expect(resumeInvestigation(ctx, run.id)).resolves.toMatchObject({ status: 'blocked' });
    await expect(startInvestigation(ctx, { businessId: second!.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('loading the same synthetic example twice does not create duplicates', () => {
    const ctx = makeCtx();
    loadGoldenCase(ctx, 'baseline-phone-only');
    loadGoldenCase(ctx, 'baseline-phone-only');
    expect(ctx.store.snapshot().businesses).toHaveLength(1);
  });
});

describe('retry is bounded and idempotent', () => {
  it('a timed-out page blocks absence claims, then recovers on retry without duplicate records or evidence', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'flaky-timeout');
    expect(run.status).toBe('partial');
    expect(run.errorSummary.some((e) => e.code === 'timeout')).toBe(true);
    expect(activeEv(db, run.id).some((e) => e.polarity === 'absence')).toBe(false);
    expect(liveOpps(db, run.id)).toHaveLength(0);
    expect(getRunDetail(ctx, run.id).canRetry).toBe(true);
    const recordsBefore = db.sourceRecords.filter((s) => s.runId === run.id).length;
    const requestsBefore = run.requestsUsed;

    const retried = await retryFailedSources(ctx, run.id);
    const after = ctx.store.snapshot();
    expect(retried.status).toBe('review_ready');
    expect(retried.requestsUsed).toBe(requestsBefore + 1); // only the failed page was requested again
    expect(after.sourceRecords.filter((s) => s.runId === run.id)).toHaveLength(recordsBefore);
    expect(after.sourceRecords.find((s) => s.sourceUrl!.endsWith('/contact'))!.attempts).toBe(2);
    expect(liveOpps(after, run.id).map((o) => o.title)).toEqual([NO_ONLINE_PATH_TITLE]);
    const keys = activeEv(after, run.id).map((e) => e.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(retried.unknowns).toHaveLength(0);

    // nothing left to retry
    await expect(retryFailedSources(ctx, run.id)).rejects.toMatchObject({ code: 'conflict' });
  });
});
