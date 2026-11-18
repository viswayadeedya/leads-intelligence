// SECURITY_PROTOCOL negative test 1 at the HTTP boundary: anonymous requests
// cannot read investigations or reports. Uses the real route handlers and the
// real file-backed store in a temporary directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { MockRuleReasoner } from '@/lib/reasoning/reasoner';
import { loadGoldenCase } from '@/lib/services/businesses';
import { reviewEvidence } from '@/lib/services/evidence';
import { startInvestigation } from '@/lib/services/investigations';
import { approveReport, approveShare, decideOpportunity, getReportBundle } from '@/lib/services/reports';
import { MockFixtureTransport } from '@/lib/sources/mock-transport';
import { JsonFileStore } from '@/lib/store';
import type { Ctx } from '@/lib/context';
import { signInForTest } from './helpers';

let dir = '';
let runId = '';
let reportId = '';
let cookie = '';
let ctx: Ctx;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-test-'));
  process.env.OI_DATA_DIR = dir;
  const config = loadConfig(process.env);
  const store = new JsonFileStore(dir);
  cookie = `oi_session=${signInForTest(store, config, new Date())}`;
  ctx = { store, config, actor: { userId: 'usr_local-operator', kind: 'human' }, now: () => new Date(), transport: new MockFixtureTransport(), reasoner: new MockRuleReasoner() };
  const [biz] = loadGoldenCase(ctx, 'private-group-note');
  const run = await startInvestigation(ctx, { businessId: biz!.id });
  runId = run.id;
  reportId = store.snapshot().reports.find((r) => r.runId === run.id)!.id;
});

afterAll(() => {
  delete process.env.OI_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (mod: { GET: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }, id: string, headers: Record<string, string> = {}) =>
  mod.GET(new Request(`http://localhost:3210/api/x/${id}`, { headers }), { params: Promise.resolve({ id }) });

describe('API routes require a valid session', () => {
  it('GET /api/investigations/:id is 401 without, or with a forged, session', async () => {
    const mod = await import('@/app/api/investigations/[id]/route');
    const attempts: Record<string, string>[] = [{}, { cookie: 'oi_session=forged-forged-forged-forged-forged-forged' }, { cookie: 'other=1' }];
    for (const headers of attempts) {
      const res = await call(mod, runId, headers);
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain('Birchwood');
    }
  });

  it('GET /api/investigations/:id returns status, cost and labelled synthetic data for the owner; 404 for unknown IDs', async () => {
    const mod = await import('@/app/api/investigations/[id]/route');
    const res = await call(mod, runId, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'review_ready', mode: 'mock', synthetic: true, spentCents: 0 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await call(mod, 'run_does-not-exist', { cookie })).status).toBe(404);
  });

  it('GET /api/reports/:id/export is 401 anonymous, 403 before approval, and never contains restricted notes', async () => {
    const mod = await import('@/app/api/reports/[id]/export/route');
    expect((await call(mod, reportId)).status).toBe(401);
    expect((await call(mod, reportId, { cookie })).status).toBe(403);

    for (const ev of ctx.store.snapshot().evidence.filter((e) => e.runId === runId)) await reviewEvidence(ctx, ev.id, 'accepted', '');
    for (const o of ctx.store.snapshot().opportunities.filter((x) => x.runId === runId)) decideOpportunity(ctx, o.id, 'accepted', 'ok');
    const bundle = getReportBundle(ctx, reportId);
    approveReport(ctx, reportId, bundle.internalHash);
    approveShare(ctx, reportId, bundle.ownerHash);

    const res = await call(mod, reportId, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    expect(text).toContain('MOCK DATA');
    expect(text).not.toContain('PRIVATE-GROUP-MARKER-7731');
    expect(text).not.toContain('members-only');
    expect((await call(mod, reportId)).status).toBe(401);
  });

  it('the data file never contains the raw session token or raw page HTML', () => {
    const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
    expect(raw).not.toContain(cookie.split('=')[1]!);
    expect(raw).not.toContain('<!doctype html>');
    expect(raw).not.toContain('<body>');
  });
});
