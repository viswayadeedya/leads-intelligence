// SECURITY_PROTOCOL negative tests 8 and 10: no outbound-type action without an
// exact human approval; jobs, requests and retries stop at configured limits.

import { describe, expect, it } from 'vitest';
import type { Ctx } from '@/lib/context';
import { redact } from '@/lib/log';
import { createBusiness, loadGoldenCase } from '@/lib/services/businesses';
import { addManualEvidence, reviewEvidence } from '@/lib/services/evidence';
import { cancelInvestigation, retryFailedSources, startInvestigation } from '@/lib/services/investigations';
import { approveOutreach, createOutreachDraft, listOutreach, logDraftCopied, markSentManually, outreachLanguageProblem, saveOutreachDraft } from '@/lib/services/outreach';
import { approveReport, decideOpportunity, getReportBundle } from '@/lib/services/reports';
import { MemoryStore } from '@/lib/store';
import { activeEv, liveOpps, makeCtx, NOW, runGolden } from './helpers';

/** A non-synthetic business with one accepted public finding and an approved report. */
async function approvedReal(ctx: Ctx) {
  const biz = createBusiness(ctx, { displayName: 'Operator Entered Heating', city: 'Ada', state: 'MI' });
  const run = await startInvestigation(ctx, { businessId: biz.id });
  const ev = await addManualEvidence(ctx, {
    runId: run.id,
    kind: 'customer_comment',
    observation: 'A public review-site comment says a voicemail was not returned.',
    observedAt: '2026-11-03',
    sourceUrl: 'https://reviews.example.invalid/operator-entered#1',
    sourceAccess: 'public_page',
    sensitivity: 'public',
    identityMatch: 'confirmed',
    topic: 'callback',
    stance: 'reports_problem',
  });
  await reviewEvidence(ctx, ev.id, 'accepted', '');
  const opp = liveOpps(ctx.store.snapshot(), run.id)[0]!;
  decideOpportunity(ctx, opp.id, 'accepted', 'Verified the link.');
  const report = ctx.store.snapshot().reports.find((r) => r.runId === run.id)!;
  approveReport(ctx, report.id, getReportBundle(ctx, report.id).internalHash);
  return { biz, run, opp, report };
}

describe('outreach requires explicit human approval', () => {
  it('no draft before the report is approved, and only from an owner-safe accepted finding', async () => {
    const ctx = makeCtx();
    const { run, db } = await runGolden(ctx, 'baseline-phone-only');
    const opp = liveOpps(db, run.id)[0]!;
    const report = db.reports.find((r) => r.runId === run.id)!;
    expect(() => createOutreachDraft(ctx, report.id, opp.id)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
  });

  it('a claim resting on restricted evidence cannot be used for outreach', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    for (const ev of activeEv(ctx.store.snapshot(), run.id)) await reviewEvidence(ctx, ev.id, 'accepted', '');
    const opps = liveOpps(ctx.store.snapshot(), run.id);
    for (const o of opps) decideOpportunity(ctx, o.id, 'accepted', 'ok');
    const report = ctx.store.snapshot().reports.find((r) => r.runId === run.id)!;
    approveReport(ctx, report.id, getReportBundle(ctx, report.id).internalHash);
    const restricted = opps.find((o) => o.title.includes('comment'))!;
    expect(() => createOutreachDraft(ctx, report.id, restricted.id)).toThrowError(/safe to show the owner/);
    const draft = createOutreachDraft(ctx, report.id, opps.find((o) => o.id !== restricted.id)!.id);
    expect(draft.body).not.toContain('PRIVATE-GROUP-MARKER');
    expect(draft.status).toBe('draft');
  });

  it('full gate: unapproved fails, wrong/expired/replayed/edited approvals fail, exact approval succeeds once', async () => {
    const store = new MemoryStore();
    let now = NOW;
    const ctx = makeCtx({ store, now: () => now });
    const { report, opp } = await approvedReal(ctx);
    const draft = createOutreachDraft(ctx, report.id, opp.id);
    expect(outreachLanguageProblem(`${draft.subject}\n${draft.body}`)).toBeNull();
    expect(draft.body).toContain('not returned');
    const refused = { code: 'approval_required' };

    // 1. not approved at all
    expect(() => markSentManually(ctx, draft.id, 'x'.repeat(43))).toThrowError(expect.objectContaining(refused));
    expect(store.snapshot().outreachDrafts[0]!.status).toBe('draft');

    // 2. approval must match the text the operator saw
    expect(() => approveOutreach(ctx, draft.id, 'stale-hash')).toThrowError(expect.objectContaining({ code: 'conflict' }));
    const item = listOutreach(ctx)[0]!;
    const { approvalToken } = approveOutreach(ctx, draft.id, item.contentHash);
    expect(JSON.stringify(store.snapshot())).not.toContain(approvalToken); // only a hash is stored

    // 3. a model or system actor cannot use even a valid token
    for (const kind of ['model', 'system'] as const) {
      expect(() => markSentManually(makeCtx({ store, kind, now: () => now }), draft.id, approvalToken)).toThrowError(expect.objectContaining(refused));
    }
    // 4. wrong token
    expect(() => markSentManually(ctx, draft.id, 'y'.repeat(43))).toThrowError(expect.objectContaining(refused));

    // 5. editing after approval withdraws it; the old token no longer matches the text
    saveOutreachDraft(ctx, draft.id, draft.subject, `${draft.body}\n\nP.S. One more line.`);
    expect(store.snapshot().outreachDrafts[0]!.status).toBe('draft');
    expect(() => markSentManually(ctx, draft.id, approvalToken)).toThrowError(expect.objectContaining(refused));

    // 6. expiry
    const second = approveOutreach(ctx, draft.id, listOutreach(ctx)[0]!.contentHash);
    now = new Date(NOW.getTime() + (ctx.config.approvalTtlMinutes + 1) * 60_000);
    expect(() => markSentManually(ctx, draft.id, second.approvalToken)).toThrowError(/expired/);
    now = NOW;

    // 7. success exactly once; replay refused
    const third = approveOutreach(ctx, draft.id, listOutreach(ctx)[0]!.contentHash);
    expect(markSentManually(ctx, draft.id, third.approvalToken).status).toBe('sent_manual');
    expect(() => markSentManually(ctx, draft.id, third.approvalToken)).toThrowError(expect.objectContaining(refused));
    expect(() => saveOutreachDraft(ctx, draft.id, 'New subject', 'New body that is long enough to pass.')).toThrowError(expect.objectContaining({ code: 'conflict' }));

    const actions = store.snapshot().auditEvents.map((a) => a.action);
    expect(actions.filter((a) => a === 'approval.refused').length).toBeGreaterThanOrEqual(3);
    expect(actions).toContain('outreach.approved');
    expect(actions).toContain('outreach.marked_sent_manually');
  });

  it('an approval issued for one user or draft cannot be used on another', async () => {
    const store = new MemoryStore();
    const a = makeCtx({ store, userId: 'usr_a' });
    const b = makeCtx({ store, userId: 'usr_b' });
    const ra = await approvedReal(a);
    const rb = await approvedReal(b);
    const da = createOutreachDraft(a, ra.report.id, ra.opp.id);
    const dbDraft = createOutreachDraft(b, rb.report.id, rb.opp.id);
    const tokenA = approveOutreach(a, da.id, listOutreach(a)[0]!.contentHash).approvalToken;
    approveOutreach(b, dbDraft.id, listOutreach(b)[0]!.contentHash);
    expect(() => markSentManually(b, dbDraft.id, tokenA)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
    expect(store.snapshot().outreachDrafts.find((d) => d.id === dbDraft.id)!.status).toBe('approved');
  });

  it('drafts about synthetic businesses can never be recorded as sent', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    for (const ev of activeEv(ctx.store.snapshot(), run.id)) {
      await reviewEvidence(ctx, ev.id, ev.identityMatchStatus === 'confirmed' ? 'accepted' : 'rejected', 'review');
    }
    const opp = liveOpps(ctx.store.snapshot(), run.id)[0]!;
    decideOpportunity(ctx, opp.id, 'accepted', 'ok');
    const report = ctx.store.snapshot().reports.find((r) => r.runId === run.id)!;
    approveReport(ctx, report.id, getReportBundle(ctx, report.id).internalHash);
    const draft = createOutreachDraft(ctx, report.id, opp.id);
    const { approvalToken } = approveOutreach(ctx, draft.id, listOutreach(ctx)[0]!.contentHash);
    expect(() => markSentManually(ctx, draft.id, approvalToken)).toThrowError(/fictional business/);
  });

  it('copying is logged as copied, not sent', async () => {
    const ctx = makeCtx();
    const { report, opp } = await approvedReal(ctx);
    const draft = createOutreachDraft(ctx, report.id, opp.id);
    logDraftCopied(ctx, draft.id);
    const db = ctx.store.snapshot();
    expect(db.outreachDrafts[0]!.status).toBe('draft');
    expect(db.outreachDrafts[0]!.sentAt).toBeNull();
    expect(db.auditEvents.find((a) => a.action === 'outreach.draft_copied')!.detail).toContain('Not sent');
  });

  it('edits that add loss, dollar, guarantee or urgency claims are refused', async () => {
    const ctx = makeCtx();
    const { report, opp } = await approvedReal(ctx);
    const draft = createOutreachDraft(ctx, report.id, opp.id);
    for (const bad of ['You are losing customers every week because of this.', 'This is costing you $2,000 a month.', 'We guarantee more booked jobs.', 'Act now, this is urgent.', 'Our clients saw 40% more calls.']) {
      expect(() => saveOutreachDraft(ctx, draft.id, draft.subject, `${draft.body}\n${bad}`), bad).toThrowError(expect.objectContaining({ code: 'validation' }));
    }
    expect(ctx.store.snapshot().outreachDrafts[0]!.body).toBe(draft.body);
  });
});

describe('limits: cost, requests, runs and retries', () => {
  it('stops at the per-run request cap, keeps evidence, marks the run partial and makes no absence claims', async () => {
    const ctx = makeCtx({ config: { maxRequests: 2 } });
    const { run, db } = await runGolden(ctx, 'baseline-phone-only');
    expect(run.requestsUsed).toBe(2); // robots.txt + home page
    expect(run.status).toBe('partial');
    expect(run.budgetExhausted).toBe(true);
    expect(run.errorSummary.some((e) => e.code === 'budget_exceeded')).toBe(true);
    const ev = activeEv(db, run.id);
    expect(ev.some((e) => e.evidenceType === 'phone_listed')).toBe(true);
    expect(ev.some((e) => e.polarity === 'absence')).toBe(false);
    expect(liveOpps(db, run.id)).toHaveLength(0);
    expect(run.unknowns.length).toBeGreaterThan(0);
    // a budget stop is not retryable into more requests
    await expect(retryFailedSources(ctx, run.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(ctx.store.snapshot().runs[0]!.requestsUsed).toBe(2);
  });

  it('never exceeds the cost cap when requests cost money', async () => {
    const base = makeCtx();
    const paid = { id: 'paid-mock', synthetic: true, costCentsPerRequest: 20, canHandle: () => true, fetchPage: base.transport.fetchPage.bind(base.transport) };
    const ctx = makeCtx({ transport: paid, config: { maxCostCents: 50 } });
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    expect(run.spentCents).toBe(40);
    expect(run.spentCents).toBeLessThanOrEqual(50);
    expect(run.requestsUsed).toBe(2);
    expect(run.status).toBe('partial');
  });

  it('limits investigations per hour', async () => {
    const ctx = makeCtx({ config: { maxRunsPerHour: 2 } });
    const keys = ['baseline-phone-only', 'phone-scheduling', 'contact-form-deeper'];
    await runGolden(ctx, keys[0]!);
    await runGolden(ctx, keys[1]!);
    const [third] = loadGoldenCase(ctx, keys[2]!);
    await expect(startInvestigation(ctx, { businessId: third!.id })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(ctx.store.snapshot().runs).toHaveLength(2);
  });

  it('bounds retries per investigation', async () => {
    const always: Ctx['transport'] = {
      id: 'always-timeout',
      synthetic: true,
      costCentsPerRequest: 0,
      canHandle: () => true,
      fetchPage: async (url) =>
        url.endsWith('/robots.txt') ? { kind: 'unavailable', reason: 'http_404', httpStatus: 404, retryable: false } : { kind: 'error', reason: 'timeout', retryable: true },
    };
    const ctx = makeCtx({ transport: always, config: { maxRetries: 2 } });
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    expect(run.status).toBe('partial');
    await retryFailedSources(ctx, run.id);
    await retryFailedSources(ctx, run.id);
    await expect(retryFailedSources(ctx, run.id)).rejects.toMatchObject({ code: 'rate_limited' });
    const db = ctx.store.snapshot();
    const pages = db.sourceRecords.filter((s) => s.runId === run.id && s.sourceType === 'website');
    expect(pages).toHaveLength(1); // one record, updated in place
    expect(pages[0]!.attempts).toBe(3);
    expect(db.runs[0]!.requestsUsed).toBe(4); // robots + 3 home attempts
    expect(activeEv(db, run.id).filter((e) => e.dedupeKey.startsWith('website:'))).toHaveLength(0);
  });

  it('idempotency key and open-run reuse prevent duplicate runs', async () => {
    const ctx = makeCtx();
    const [biz] = loadGoldenCase(ctx, 'baseline-phone-only');
    const first = await startInvestigation(ctx, { businessId: biz!.id, idempotencyKey: 'form-123' });
    const again = await startInvestigation(ctx, { businessId: biz!.id, idempotencyKey: 'form-123' });
    expect(again.id).toBe(first.id);
    const db = ctx.store.snapshot();
    expect(db.runs).toHaveLength(1);
    expect(db.sourceRecords.filter((s) => s.runId === first.id && s.sourceType === 'website')).toHaveLength(3);
  });

  it('a failing transport marks the run failed, never clean', async () => {
    const broken: Ctx['transport'] = { id: 'broken', synthetic: true, costCentsPerRequest: 0, canHandle: () => true, fetchPage: async () => { throw new Error('socket exploded'); } };
    const ctx = makeCtx({ transport: broken });
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    expect(run.status).toBe('failed');
    expect(run.errorSummary[0]!.message).toContain('No conclusions were drawn');
    expect(liveOpps(ctx.store.snapshot(), run.id)).toHaveLength(0);
  });

  it('a reasoner that throws or returns junk leaves evidence reviewable and reports the failure', async () => {
    for (const reasoner of [{ version: 'junk', propose: async () => 'I will email everyone' }, { version: 'throws', propose: async () => { throw new Error('boom'); } }]) {
      const ctx = makeCtx({ reasoner });
      const { run, db } = await runGolden(ctx, 'baseline-phone-only');
      expect(run.status).toBe('partial');
      expect(run.errorSummary.some((e) => e.code === 'model_invalid_output')).toBe(true);
      expect(liveOpps(db, run.id)).toHaveLength(0);
      expect(activeEv(db, run.id).length).toBeGreaterThan(0);
    }
  });

  it('a stopped investigation cannot be resumed or retried', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'flaky-timeout');
    expect(cancelInvestigation(ctx, run.id).status).toBe('canceled');
    await expect(retryFailedSources(ctx, run.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('manual evidence requires provenance and a privacy class, and refuses personal identifiers', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    const good = { runId: run.id, kind: 'customer_comment', observation: 'A public comment says the office was closed on a Saturday.', observedAt: '2026-11-01', sourceUrl: 'https://reviews.example.invalid/a', sourceAccess: 'public_page', sensitivity: 'public', identityMatch: 'confirmed', topic: 'contact', stance: 'reports_problem' };
    const bad: Record<string, unknown>[] = [
      { ...good, sensitivity: undefined },
      { ...good, sourceAccess: undefined },
      { ...good, identityMatch: undefined },
      { ...good, observedAt: 'yesterday' },
      { ...good, observedAt: '2031-01-01' },
      { ...good, sourceUrl: undefined },
      { ...good, sourceUrl: 'javascript:alert(1)' },
      { ...good, observation: 'short' },
      { ...good, observation: 'jane.doe@example.com said the office never called back about her furnace.' },
      { ...good, observation: 'Reddit user u/coldhouse42 said the office did not call back.' },
      { ...good, kind: 'search_observation' },
      { ...good, ownerId: 'usr_other' },
    ];
    for (const input of bad) await expect(addManualEvidence(ctx, input), JSON.stringify(input)).rejects.toMatchObject({ code: 'validation' });
    await expect(addManualEvidence(ctx, good)).resolves.toMatchObject({ verificationStatus: 'needs_review', sensitivity: 'public' });
    await expect(addManualEvidence(ctx, good)).rejects.toMatchObject({ code: 'conflict' }); // no duplicate evidence
  });
});

describe('log redaction (negative test 3, logs)', () => {
  it('removes secrets, cookies, tokens and source bodies', () => {
    const out = JSON.stringify(
      redact({
        action: 'x',
        apiKey: 'sk-live-abc',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOi',
        headers: { cookie: 'oi_session=abc', authorization: 'Bearer abc' },
        sessionToken: 'abc',
        body: '<html>source</html>',
        nested: { passphrase: 'hunter2', note: 'n'.repeat(500) },
      }),
    );
    for (const secret of ['sk-live-abc', 'eyJhbGciOi', 'oi_session=abc', 'Bearer abc', 'hunter2', '<html>']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('[truncated]');
  });
});
