// SECURITY_PROTOCOL negative tests 1, 2 and 11: anonymous access, cross-user
// access (IDOR) and CSRF origin checks.

import { describe, expect, it } from 'vitest';
import { parseCookieHeader, resolveSession, signInMock, signInWithPassphrase, signOut } from '@/lib/auth';
import { loadConfig } from '@/lib/config';
import { buildCsp, isPublicPath, isSameOrigin, isStateChanging } from '@/lib/security/origin';
import { confirmIdentity, createBusiness, getBusiness, listBusinesses, resolveDuplicate } from '@/lib/services/businesses';
import { addManualEvidence, getEvidenceDesk, reviewEvidence } from '@/lib/services/evidence';
import { cancelInvestigation, getRunDetail, listRuns, resumeInvestigation, retryFailedSources, startInvestigation } from '@/lib/services/investigations';
import { approveOutreach, createOutreachDraft, listOutreach, logDraftCopied, markSentManually, saveOutreachDraft } from '@/lib/services/outreach';
import { approveReport, approveShare, decideOpportunity, exportOwnerReport, getReportBundle, listReports } from '@/lib/services/reports';
import { MemoryStore } from '@/lib/store';
import { liveOpps, makeCtx, NOW, runGolden } from './helpers';

describe('sessions', () => {
  const config = loadConfig({});

  it('anonymous or forged tokens resolve to no actor', () => {
    const store = new MemoryStore();
    signInMock(store, config, NOW);
    for (const token of [undefined, null, '', 'short', 'x'.repeat(43), 'a'.repeat(300)]) {
      expect(resolveSession(store, NOW, token)).toBeNull();
    }
  });

  it('a valid session resolves to the human operator, expires, and is invalidated by sign-out', () => {
    const store = new MemoryStore();
    const token = signInMock(store, config, NOW);
    expect(resolveSession(store, NOW, token)).toEqual({ userId: 'usr_local-operator', kind: 'human' });
    const later = new Date(NOW.getTime() + (config.sessionTtlMinutes + 1) * 60_000);
    expect(resolveSession(store, later, token)).toBeNull();
    signOut(store, token);
    expect(resolveSession(store, NOW, token)).toBeNull();
  });

  it('stores only a hash of the session token', () => {
    const store = new MemoryStore();
    const token = signInMock(store, config, NOW);
    expect(JSON.stringify(store.snapshot())).not.toContain(token);
  });

  it('one-click mock sign-in is disabled once a passphrase is configured; wrong passphrases are rate limited', () => {
    const store = new MemoryStore();
    const locked = loadConfig({ OPERATOR_PASSPHRASE: 'correct horse battery staple' });
    expect(() => signInMock(store, locked, NOW)).toThrowError(/passphrase/);
    for (let i = 0; i < 5; i++) {
      expect(() => signInWithPassphrase(store, locked, NOW, 'wrong', 'correct horse battery staple', 'client-1')).toThrowError(/not accepted/);
    }
    expect(() => signInWithPassphrase(store, locked, NOW, 'correct horse battery staple', 'correct horse battery staple', 'client-1')).toThrowError(/Too many/);
    const token = signInWithPassphrase(store, locked, NOW, 'correct horse battery staple', 'correct horse battery staple', 'client-2');
    expect(resolveSession(store, NOW, token)).not.toBeNull();
  });

  it('parses the session cookie from a raw header', () => {
    expect(parseCookieHeader('a=1; oi_session=abc%3D; b=2', 'oi_session')).toBe('abc=');
    expect(parseCookieHeader(null, 'oi_session')).toBeNull();
    expect(parseCookieHeader('other=1', 'oi_session')).toBeNull();
  });
});

describe('cross-user access (IDOR): user B cannot read or modify user A objects', () => {
  it('denies every service call with "not found" and leaves A data unchanged', async () => {
    const store = new MemoryStore();
    const a = makeCtx({ store, userId: 'usr_a' });
    const b = makeCtx({ store, userId: 'usr_b' });

    // A builds a complete chain: business -> run -> evidence -> opportunity -> report -> draft
    const { run, business, db } = await runGolden(a, 'baseline-phone-only');
    const opp = liveOpps(db, run.id)[0]!;
    for (const ev of db.evidence.filter((e) => e.runId === run.id)) {
      if (ev.identityMatchStatus === 'confirmed') await reviewEvidence(a, ev.id, 'accepted', '');
      else await reviewEvidence(a, ev.id, 'rejected', 'Different company.');
    }
    decideOpportunity(a, opp.id, 'accepted', 'Checked by hand.');
    const report = a.store.snapshot().reports.find((r) => r.runId === run.id)!;
    approveReport(a, report.id, getReportBundle(a, report.id).internalHash);
    const draft = createOutreachDraft(a, report.id, opp.id);
    const evidenceId = opp.evidenceIds[0]!;
    const before = JSON.stringify({ ...store.snapshot(), auditEvents: [] });

    const notFound = { code: 'not_found' };
    // reads
    expect(() => getBusiness(b, business.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => getRunDetail(b, run.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => getEvidenceDesk(b, run.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => getReportBundle(b, report.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => exportOwnerReport(b, report.id)).toThrowError(expect.objectContaining(notFound));
    // lists are empty for B
    expect(listBusinesses(b)).toHaveLength(0);
    expect(listRuns(b)).toHaveLength(0);
    expect(listReports(b)).toHaveLength(0);
    expect(listOutreach(b)).toHaveLength(0);
    // writes
    await expect(startInvestigation(b, { businessId: business.id })).rejects.toMatchObject(notFound);
    await expect(resumeInvestigation(b, run.id)).rejects.toMatchObject(notFound);
    await expect(retryFailedSources(b, run.id)).rejects.toMatchObject(notFound);
    expect(() => cancelInvestigation(b, run.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => confirmIdentity(b, business.id, 'not mine')).toThrowError(expect.objectContaining(notFound));
    expect(() => resolveDuplicate(b, business.id, 'kept_separate', 'not mine')).toThrowError(expect.objectContaining(notFound));
    await expect(reviewEvidence(b, evidenceId, 'rejected', 'tampering')).rejects.toMatchObject(notFound);
    await expect(
      addManualEvidence(b, { runId: run.id, kind: 'operator_observation', observation: 'Injected by another user.', observedAt: '2026-11-01', sourceUrl: 'https://x.example.invalid/', sourceAccess: 'public_page', sensitivity: 'public', identityMatch: 'confirmed', topic: 'other', stance: 'neutral' }),
    ).rejects.toMatchObject(notFound);
    expect(() => decideOpportunity(b, opp.id, 'rejected', 'tampering')).toThrowError(expect.objectContaining(notFound));
    expect(() => approveReport(b, report.id, 'x')).toThrowError(expect.objectContaining(notFound));
    expect(() => approveShare(b, report.id, 'x')).toThrowError(expect.objectContaining(notFound));
    expect(() => createOutreachDraft(b, report.id, opp.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => saveOutreachDraft(b, draft.id, 'Changed subject', 'Changed body text that is long enough.')).toThrowError(expect.objectContaining(notFound));
    expect(() => approveOutreach(b, draft.id, 'x')).toThrowError(expect.objectContaining(notFound));
    expect(() => markSentManually(b, draft.id, 'x'.repeat(43))).toThrowError(expect.objectContaining(notFound));
    expect(() => logDraftCopied(b, draft.id)).toThrowError(expect.objectContaining(notFound));

    expect(JSON.stringify({ ...store.snapshot(), auditEvents: [] })).toBe(before);
    // B's audit trail contains nothing about A's objects
    expect(store.snapshot().auditEvents.filter((e) => e.ownerId === 'usr_b')).toHaveLength(0);
  });

  it('a business created by A is invisible to B', async () => {
    const store = new MemoryStore();
    const a = makeCtx({ store, userId: 'usr_a' });
    const b = makeCtx({ store, userId: 'usr_b' });
    const biz = createBusiness(a, { displayName: 'Real Shop Heating', city: 'Grand Rapids', state: 'MI' });
    expect(() => getBusiness(b, biz.id)).toThrowError(/not found/);
  });

  it('client input cannot set owner or trust fields (mass assignment)', () => {
    const ctx = makeCtx();
    expect(() => createBusiness(ctx, { displayName: 'X Heating', city: 'Ada', state: 'MI', ownerId: 'usr_victim' })).toThrowError(expect.objectContaining({ code: 'validation' }));
    expect(() => createBusiness(ctx, { displayName: 'X Heating', city: 'Ada', state: 'MI', synthetic: true, identityStatus: 'confirmed' })).toThrowError(expect.objectContaining({ code: 'validation' }));
    const made = createBusiness(ctx, { displayName: 'X Heating', city: 'Ada', state: 'MI' });
    expect(made.ownerId).toBe('usr_a');
    expect(made.synthetic).toBe(false);
    expect(made.identityStatus).toBe('unverified');
  });

  it('website input rejects internal hosts, IPs, credentials and non-http schemes', () => {
    const ctx = makeCtx();
    for (const domain of ['localhost', '127.0.0.1', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:pw@example.com', 'javascript:alert(1)', 'http://[::1]/', 'intranet']) {
      expect(() => createBusiness(ctx, { displayName: 'Y Heating', city: 'Ada', state: 'MI', domain }), domain).toThrowError(expect.objectContaining({ code: 'validation' }));
    }
    expect(createBusiness(ctx, { displayName: 'Y Heating', city: 'Ada', state: 'MI', domain: 'https://www.Example.com/contact' }).domain).toBe('example.com');
  });
});

describe('non-human actors cannot take review, approval or outbound actions', () => {
  it.each(['model', 'system'] as const)('%s actor is refused', async (kind) => {
    const store = new MemoryStore();
    const human = makeCtx({ store });
    const { run, db } = await runGolden(human, 'baseline-phone-only');
    const opp = liveOpps(db, run.id)[0]!;
    const report = db.reports.find((r) => r.runId === run.id)!;
    const robot = makeCtx({ store, kind });
    const refused = { code: 'approval_required' };
    await expect(reviewEvidence(robot, opp.evidenceIds[0]!, 'accepted', '')).rejects.toMatchObject(refused);
    expect(() => decideOpportunity(robot, opp.id, 'accepted', '')).toThrowError(expect.objectContaining(refused));
    expect(() => approveReport(robot, report.id, 'x')).toThrowError(expect.objectContaining(refused));
    expect(() => approveShare(robot, report.id, 'x')).toThrowError(expect.objectContaining(refused));
    expect(() => createOutreachDraft(robot, report.id, opp.id)).toThrowError(expect.objectContaining(refused));
    expect(() => exportOwnerReport(robot, report.id)).toThrowError(expect.objectContaining(refused));
    await expect(startInvestigation(robot, { businessId: run.businessId })).rejects.toMatchObject(refused);
  });
});

describe('CSRF origin check and CSP', () => {
  it('treats only GET/HEAD/OPTIONS as safe', () => {
    expect(isStateChanging('GET')).toBe(false);
    expect(isStateChanging('head')).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isStateChanging(m)).toBe(true);
  });

  it('requires a present, matching Origin for state-changing requests', () => {
    expect(isSameOrigin('http://localhost:3210', 'localhost:3210')).toBe(true);
    expect(isSameOrigin('https://app.example.com', 'app.example.com')).toBe(true);
    expect(isSameOrigin(null, 'localhost:3210')).toBe(false);
    expect(isSameOrigin('null', 'localhost:3210')).toBe(false);
    expect(isSameOrigin('https://evil.example.net', 'localhost:3210')).toBe(false);
    expect(isSameOrigin('http://localhost:9999', 'localhost:3210')).toBe(false);
    expect(isSameOrigin('http://localhost:3210.evil.example.net', 'localhost:3210')).toBe(false);
    expect(isSameOrigin('garbage', 'localhost:3210')).toBe(false);
    expect(isSameOrigin('http://localhost:3210', null)).toBe(false);
  });

  it('only /login is reachable without a session', () => {
    expect(isPublicPath('/login')).toBe(true);
    for (const p of ['/', '/reports/x', '/api/investigations/x', '/login/extra', '/settings']) expect(isPublicPath(p)).toBe(false);
  });

  it('production CSP has no unsafe-inline or unsafe-eval and forbids framing', () => {
    const csp = buildCsp('abc123', false);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
  });
});
