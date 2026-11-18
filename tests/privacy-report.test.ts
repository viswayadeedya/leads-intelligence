// SECURITY_PROTOCOL negative tests 7 and 9: restricted material never reaches
// the owner view or export, and hostile text is neutralized in exports.

import { describe, expect, it } from 'vitest';
import { NO_ONLINE_PATH_TITLE, SINGLE_COMMENT_TITLE } from '@/fixtures/golden';
import type { Ctx } from '@/lib/context';
import { createBusiness } from '@/lib/services/businesses';
import { addManualEvidence, reviewEvidence } from '@/lib/services/evidence';
import { startInvestigation } from '@/lib/services/investigations';
import { approveReport, approveShare, buildOwnerView, decideOpportunity, exportOwnerReport, getReportBundle, isOwnerSafeEvidence, mdEscape, renderOwnerMarkdown } from '@/lib/services/reports';
import type { Db } from '@/lib/types';
import { activeEv, liveOpps, makeCtx, NOW, runGolden } from './helpers';

const MARKER = 'PRIVATE-GROUP-MARKER-7731';

async function acceptEverything(ctx: Ctx, runId: string): Promise<void> {
  for (const ev of activeEv(ctx.store.snapshot(), runId)) {
    if (ev.identityMatchStatus === 'confirmed') await reviewEvidence(ctx, ev.id, 'accepted', '');
    else await reviewEvidence(ctx, ev.id, 'rejected', 'Different business.');
  }
  for (const opp of liveOpps(ctx.store.snapshot(), runId)) decideOpportunity(ctx, opp.id, 'accepted', 'Reviewed.');
}

function reportId(db: Db, runId: string): string {
  return db.reports.find((r) => r.runId === runId)!.id;
}

describe('owner view: private-group note accidentally attached', () => {
  it('keeps the note internal and withholds any claim that depends on it', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    const bundle = getReportBundle(ctx, reportId(ctx.store.snapshot(), run.id));

    // internal view shows both claims and the note
    expect(bundle.internal.opportunities.map((o) => o.title).sort()).toEqual([NO_ONLINE_PATH_TITLE, SINGLE_COMMENT_TITLE].sort());
    expect(JSON.stringify(bundle.internal)).toContain(MARKER);

    // owner view: the website claim only
    expect(bundle.owner.opportunities.map((o) => o.title)).toEqual([NO_ONLINE_PATH_TITLE]);
    expect(JSON.stringify(bundle.owner)).not.toContain(MARKER);
    expect(JSON.stringify(bundle.owner)).not.toContain('members-only');
    expect(bundle.ownerMarkdown).not.toContain(MARKER);
    expect(bundle.ownerMarkdown).not.toContain('members-only');
    expect(bundle.owner.sources.every((s) => !s.manual)).toBe(true);
    expect(bundle.redaction.opportunitiesWithheld).toEqual([{ title: SINGLE_COMMENT_TITLE, reason: 'Relies on restricted, personal or non-public evidence.' }]);
    expect(bundle.redaction.evidenceWithheld).toBeGreaterThanOrEqual(1);
  });

  it('the approved export contains no restricted material and is the exact approved text', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    const id = reportId(ctx.store.snapshot(), run.id);
    const bundle = getReportBundle(ctx, id);
    expect(() => exportOwnerReport(ctx, id)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
    approveReport(ctx, id, bundle.internalHash);
    expect(() => exportOwnerReport(ctx, id)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
    approveShare(ctx, id, bundle.ownerHash);
    const exported = exportOwnerReport(ctx, id);
    expect(exported.markdown).toBe(bundle.ownerMarkdown);
    expect(exported.markdown).not.toContain(MARKER);
    expect(exported.markdown).toContain('MOCK DATA');
    expect(ctx.store.snapshot().auditEvents.some((a) => a.action === 'report.exported')).toBe(true);
  });

  it('a gated source can never be classified public, whatever the operator selects', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    for (const sourceAccess of ['login_required', 'private_group'] as const) {
      const ev = await addManualEvidence(ctx, {
        runId: run.id,
        kind: 'customer_comment',
        observation: `Someone in a gated space said the office did not call back (${sourceAccess}).`,
        observedAt: '2026-11-02',
        sourceAccess,
        sensitivity: 'public',
        identityMatch: 'confirmed',
        topic: 'callback',
        stance: 'reports_problem',
      });
      expect(ev.sensitivity).toBe('restricted');
    }
    await acceptEverything(ctx, run.id);
    const bundle = getReportBundle(ctx, reportId(ctx.store.snapshot(), run.id));
    expect(bundle.ownerMarkdown).not.toContain('gated space');
    expect(bundle.owner.opportunities.map((o) => o.title)).toEqual([NO_ONLINE_PATH_TITLE]);
  });

  it('fails closed: evidence with a missing or unknown privacy class is excluded', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    await acceptEverything(ctx, run.id);
    // corrupt the stored classification the way a bad migration might
    ctx.store.transact((db) => {
      for (const e of db.evidence.filter((x) => x.runId === run.id)) {
        (e as unknown as { sensitivity: unknown }).sensitivity = undefined;
      }
    });
    const db = ctx.store.snapshot();
    const { view, redaction } = buildOwnerView(db, run.id, NOW, 180);
    expect(view.opportunities).toHaveLength(0);
    expect(redaction.opportunitiesWithheld).toHaveLength(1);
    const sources = new Map(db.sourceRecords.map((r) => [r.id, r]));
    expect(db.evidence.filter((e) => e.runId === run.id).some((e) => isOwnerSafeEvidence(e, sources))).toBe(false);
  });

  it('instruction-like page text and unreviewed evidence never appear in the owner view', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'prompt-injection');
    const before = getReportBundle(ctx, reportId(ctx.store.snapshot(), run.id));
    expect(before.owner.opportunities).toHaveLength(0); // nothing reviewed yet
    await acceptEverything(ctx, run.id);
    const after = getReportBundle(ctx, reportId(ctx.store.snapshot(), run.id));
    expect(after.owner.opportunities).toHaveLength(1);
    expect(after.ownerMarkdown).not.toContain('ignore previous instructions');
    expect(after.ownerMarkdown).not.toContain('attacker');
  });
});

describe('approval is bound to exact content', () => {
  it('cannot approve with pending reviews, a stale hash, or out of order; later changes withdraw approval', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    const id = reportId(ctx.store.snapshot(), run.id);
    const first = getReportBundle(ctx, id);
    expect(first.blockers.length).toBeGreaterThan(0);
    expect(() => approveReport(ctx, id, first.internalHash)).toThrowError(expect.objectContaining({ code: 'conflict' }));
    expect(() => approveShare(ctx, id, first.ownerHash)).toThrowError(expect.objectContaining({ code: 'conflict' }));

    await acceptEverything(ctx, run.id);
    expect(() => approveReport(ctx, id, first.internalHash)).toThrowError(/changed after you opened it/);
    const ready = getReportBundle(ctx, id);
    expect(ready.blockers).toEqual([]);
    expect(approveReport(ctx, id, ready.internalHash).status).toBe('approved_internal');
    expect(() => approveShare(ctx, id, 'wrong-hash')).toThrowError(/changed after you previewed it/);
    expect(approveShare(ctx, id, ready.ownerHash).status).toBe('approved_to_share');

    // rejecting evidence afterwards reopens the report and clears the shared snapshot
    const opp = liveOpps(ctx.store.snapshot(), run.id)[0]!;
    await reviewEvidence(ctx, opp.evidenceIds[0]!, 'rejected', 'On second look this was wrong.');
    const reopened = ctx.store.snapshot().reports.find((r) => r.id === id)!;
    expect(reopened.status).toBe('evidence_review');
    expect(reopened.version).toBe(2);
    expect(reopened.sharedSnapshot).toBeNull();
    expect(() => exportOwnerReport(ctx, id)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
    expect(ctx.store.snapshot().auditEvents.some((a) => a.action === 'report.reopened')).toBe(true);
  });

  it('"no finding" is a valid, approvable outcome', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'phone-scheduling');
    await acceptEverything(ctx, run.id);
    const id = reportId(ctx.store.snapshot(), run.id);
    const bundle = getReportBundle(ctx, id);
    expect(bundle.internal.opportunities).toHaveLength(0);
    expect(bundle.internal.executiveFinding).toContain('no evidence-backed observation');
    expect(approveReport(ctx, id, bundle.internalHash).status).toBe('approved_internal');
  });
});

describe('hostile text is neutralized', () => {
  it('escapes Markdown and HTML control characters', () => {
    const hostile = '<script>alert(1)</script> [click](javascript:alert(1)) ![x](http://evil.example.net/a.png) `code` *bold* # h\nnew line | pipe';
    const out = mdEscape(hostile);
    expect(out).not.toContain('<script>');
    expect(out).not.toMatch(/(^|[^\\])\[click\]/);
    expect(out).not.toMatch(/(^|[^\\])\]\(/);
    expect(out).not.toContain('\n');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('\\[click\\](javascript:alert(1))');
    expect(out).toContain('!\\[x\\](http://evil.example.net/a.png)');
  });

  it('a malicious business name and observation cannot inject markup into the owner export', async () => {
    const ctx = makeCtx();
    const biz = createBusiness(ctx, { displayName: '<img src=x onerror=alert(1)> [Free](javascript:alert(1)) Heating', city: 'Ada', state: 'MI' });
    const run = await startInvestigation(ctx, { businessId: biz.id });
    const ev = await addManualEvidence(ctx, {
      runId: run.id,
      kind: 'customer_comment',
      observation: 'A public comment says the voicemail was not returned <script>alert("x")</script> [link](javascript:alert(2)).',
      observedAt: '2026-11-03',
      sourceUrl: 'https://reviews.example.invalid/x?a=<b>&c=)',
      sourceAccess: 'public_page',
      sensitivity: 'public',
      identityMatch: 'confirmed',
      topic: 'callback',
      stance: 'reports_problem',
    });
    await reviewEvidence(ctx, ev.id, 'accepted', '');
    for (const opp of liveOpps(ctx.store.snapshot(), run.id)) decideOpportunity(ctx, opp.id, 'accepted', 'ok');
    const { view } = buildOwnerView(ctx.store.snapshot(), run.id, NOW, 180);
    expect(view.opportunities).toHaveLength(1);
    const md = renderOwnerMarkdown(view);
    expect(md).not.toContain('<img');
    expect(md).not.toContain('<script');
    expect(md).not.toContain('<b>');
    expect(md).not.toMatch(/(^|[^\\])\]\(javascript:/);
    expect(md).toContain('&lt;img src=x onerror=alert(1)&gt; \\[Free\\](javascript:alert(1))');
    // the source URL is printed as a plain, percent-encoded http(s) URL
    expect(md).toContain('https://reviews.example.invalid/x?a=%3Cb%3E&c=%29');
  });

  it('the internal view cannot be exported as an owner document', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    const bundle = getReportBundle(ctx, reportId(ctx.store.snapshot(), run.id));
    expect(() => renderOwnerMarkdown(bundle.internal)).toThrowError(expect.objectContaining({ code: 'forbidden' }));
  });
});
