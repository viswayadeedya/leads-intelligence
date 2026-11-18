// The operator live test mode: real requests are possible ONLY to hostnames
// the operator approved, exactly. Everything here runs against controlled
// servers on this machine (tests/lab); no request leaves it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { createApprovedLiveTransport, validateApprovedHosts, type ApprovedLiveDeps } from '@/lib/security/safe-fetch';
import { MAX_APPROVAL_AGE_DAYS, parseApprovals } from '../tools/live-test/approvals';
import { LIVE_TEST_LIMITS, runLiveInvestigation } from '../tools/live-test/run';
import { html, Lab, makeTestCert, redirect, sendHtml } from './lab/controlled-net';

let lab: Lab;
beforeAll(async () => {
  lab = await Lab.start();
});
afterAll(async () => {
  await lab.close();
});

let n = 0;
const name = (label: string) => `${label}-${++n}.example.com`;
const OPTS = { timeoutMs: 600, maxBytes: 50_000, maxRedirects: 3, minDelayMs: 0, maxWireRequests: 20 };
const deps = (over: Partial<ApprovedLiveDeps> = {}): Partial<ApprovedLiveDeps> => ({ resolve: lab.resolver, createRequest: lab.requestFactory, ...over });

describe('approved hostnames: what can be approved', () => {
  it.each([
    ['empty list', []],
    ['an IP address', ['93.184.216.34']],
    ['an IPv6 address', ['[2606:2800:220:1::1]']],
    ['localhost', ['localhost']],
    ['a single label', ['intranet']],
    ['an internal suffix', ['db.internal']],
    ['a wildcard', ['*.example.com']],
    ['a leading dot', ['.example.com']],
    ['a scheme', ['https://example.com']],
    ['a path', ['example.com/contact']],
    ['a port', ['example.com:8443']],
    ['credentials', ['user@example.com']],
    ['a space', ['example .com']],
    ['a comma-joined pair', ['a.example.com,b.example.com']],
    ['not a string', [42 as unknown as string]],
    ['too many', Array.from({ length: 11 }, (_, i) => `h${i}.example.com`)],
  ])('refuses %s', (_label, hosts) => {
    expect(() => validateApprovedHosts(hosts)).toThrow();
    expect(() => createApprovedLiveTransport({ ...OPTS, approvedHosts: hosts }, deps())).toThrow();
  });

  it('accepts exact public hostnames, lower-cases them and removes duplicates', () => {
    expect(validateApprovedHosts(['Example.com', 'www.example.com', 'example.com'])).toEqual(['example.com', 'www.example.com']);
  });
});

describe('approved-host transport against controlled servers', () => {
  it('requests an approved host; refuses everything else before any lookup or connection', async () => {
    const ok = name('approved');
    const other = name('not-approved');
    const okSite = await lab.site(ok, (_req, res) => sendHtml(res, html('<h1>ok</h1>')));
    const otherSite = await lab.site(other, (_req, res) => sendHtml(res, html('<h1>other</h1>')));
    const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [ok] }, deps());
    const before = { lookups: lab.lookups.length, dialed: lab.dialed.length };

    for (const url of [`http://${other}/`, `http://www.${ok}/`, `http://x${ok}/`, `http://${ok}.evil.example.net/`, `http://${ok.replace(/^[^.]+\./, '')}/`, 'http://127.0.0.1/', 'http://localhost/', 'not a url']) {
      const out = await transport.fetchPage(url, 0);
      expect(out, url).toMatchObject({ kind: 'error' });
      if (out.kind === 'error') expect(out.reason).toMatch(/^security_blocked:(host_not_approved|invalid_url)$/);
    }
    expect(lab.lookups.length).toBe(before.lookups);
    expect(lab.dialed.length).toBe(before.dialed);
    expect(otherSite.hits).toEqual([]);
    expect(transport.canHandle!(other)).toBe(false);
    expect(transport.canHandle!(`www.${ok}`)).toBe(false);

    expect(await transport.fetchPage(`http://${ok}/`, 0)).toMatchObject({ kind: 'ok' });
    expect(okSite.hits).toHaveLength(1);
    expect(transport.log.map((l) => l.outcome)).toEqual([...Array(8).fill('refused'), 'ok']);
    expect(transport.wireRequests()).toBe(1);
    expect(lab.canary.hits).toEqual([]);
    expect(lab.strayDials()).toEqual([]);
  });

  it('a redirect may land only on another approved hostname', async () => {
    const host = name('apex');
    const elsewhere = name('elsewhere');
    const elsewhereSite = await lab.site(elsewhere, (_req, res) => sendHtml(res, html('someone else')));
    const site = await lab.site(host, (req, res) => {
      if (req.headers.host === host && req.url === '/') redirect(res, `http://www.${host}/`, 301);
      else if (req.url === '/out') redirect(res, `http://${elsewhere}/`);
      else sendHtml(res, html('<h1>www home</h1>'));
    });
    lab.setDns(`www.${host}`, [{ address: site.ip, family: 4 }]);

    // "www." was not approved: the redirect is not followed.
    const strict = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host] }, deps());
    expect(await strict.fetchPage(`http://${host}/`, 0)).toMatchObject({ kind: 'restricted', reason: 'redirected_off_domain' });
    expect(lab.lookupCount(`www.${host}`)).toBe(0);

    // Both forms approved: followed.
    const both = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host, `www.${host}`] }, deps());
    expect(await both.fetchPage(`http://${host}/`, 0)).toMatchObject({ kind: 'ok', finalUrl: `http://www.${host}/` });
    // A third site is never contacted, approved "www." or not.
    expect(await both.fetchPage(`http://${host}/out`, 0)).toMatchObject({ kind: 'restricted', reason: 'redirected_off_domain' });
    expect(elsewhereSite.hits).toEqual([]);
    expect(lab.lookupCount(elsewhere)).toBe(0);
  });

  it('an approved hostname that resolves to a private address is still refused, with no connection', async () => {
    const host = name('approved-but-private');
    lab.setDns(host, [{ address: '10.0.0.7', family: 4 }]);
    const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host] }, deps());
    const before = lab.dialed.length;
    expect(await transport.fetchPage(`http://${host}/`, 0)).toMatchObject({ kind: 'error', reason: 'security_blocked:dns_non_public_ipv4' });
    expect(lab.dialed.length).toBe(before);
    expect(transport.wireRequests()).toBe(0);
    expect(lab.canary.hits).toEqual([]);
  });

  it('pauses between requests to the same host', async () => {
    const host = name('polite');
    await lab.site(host, (_req, res) => sendHtml(res, html('ok')));
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const transport = createApprovedLiveTransport(
      { ...OPTS, minDelayMs: 2_000, approvedHosts: [host] },
      deps({
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      }),
    );
    await transport.fetchPage(`http://${host}/a`, 0);
    clock += 300;
    await transport.fetchPage(`http://${host}/b`, 0);
    clock += 5_000;
    await transport.fetchPage(`http://${host}/c`, 0);
    expect(sleeps).toEqual([1_700]);
  });

  it('a hard ceiling on requests put on the wire, redirects included', async () => {
    const host = name('ceiling');
    const site = await lab.site(host, (req, res) => (req.url!.length < 40 ? redirect(res, `${req.url}x`) : sendHtml(res, html('end'))));
    const transport = createApprovedLiveTransport({ ...OPTS, maxRedirects: 3, maxWireRequests: 6, approvedHosts: [host] }, deps());
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await transport.fetchPage(`http://${host}/p${i}`, 0);
      outcomes.push(out.kind === 'error' ? out.reason : out.kind === 'unavailable' ? out.reason : out.kind);
    }
    expect(site.hits.length).toBe(6);
    expect(transport.wireRequests()).toBe(6);
    expect(outcomes.slice(2)).toEqual(['security_blocked:egress_refused', 'security_blocked:egress_refused', 'security_blocked:egress_refused']);
  });
});

describe('approvals file', () => {
  const NOW = new Date('2026-11-18T12:00:00Z');
  const base = () => ({
    purpose: 'Phase 2 gate: three permitted websites.',
    approvedBy: 'operator',
    approvedAt: '2026-11-18T10:00:00Z',
    approvalRecord: 'Approved in conversation.',
    businesses: [
      { label: 'A', displayName: 'Lab Heating Co', city: 'Testville', state: 'MI', phone: null, domain: 'lab-heating.example.com', approvedHosts: ['lab-heating.example.com', 'www.lab-heating.example.com'], operatorConfirmsIdentity: false, selectionNote: 'Test.' },
    ],
  });
  const bad = (change: (a: ReturnType<typeof base>) => unknown) => {
    const a = base();
    const replaced = change(a);
    return () => parseApprovals(replaced === undefined ? a : replaced, NOW);
  };

  it('accepts a well-formed record', () => {
    const parsed = parseApprovals(base(), NOW);
    expect(parsed.businesses[0]).toMatchObject({ label: 'A', domain: 'lab-heating.example.com', approvedHosts: ['lab-heating.example.com', 'www.lab-heating.example.com'] });
  });

  it.each([
    ['unknown field', (a: ReturnType<typeof base>) => ({ ...a, allowAll: true })],
    ['unknown business field', (a: ReturnType<typeof base>) => void Object.assign(a.businesses[0]!, { anyHost: true })],
    ['no businesses', (a: ReturnType<typeof base>) => void (a.businesses = [])],
    ['the domain is not in its own list', (a: ReturnType<typeof base>) => void (a.businesses[0]!.approvedHosts = ['www.lab-heating.example.com'])],
    ['an unrelated host rides along', (a: ReturnType<typeof base>) => void (a.businesses[0]!.approvedHosts = ['lab-heating.example.com', 'other-site.example.com'])],
    ['a subdomain other than www', (a: ReturnType<typeof base>) => void (a.businesses[0]!.approvedHosts = ['lab-heating.example.com', 'shop.lab-heating.example.com'])],
    ['a wildcard host', (a: ReturnType<typeof base>) => void (a.businesses[0]!.approvedHosts = ['*.example.com'])],
    ['three hosts', (a: ReturnType<typeof base>) => void (a.businesses[0]!.approvedHosts = ['lab-heating.example.com', 'www.lab-heating.example.com', 'm.lab-heating.example.com'])],
    ['an internal domain', (a: ReturnType<typeof base>) => void Object.assign(a.businesses[0]!, { domain: 'router.local', approvedHosts: ['router.local'] })],
    ['a lower-case label', (a: ReturnType<typeof base>) => void (a.businesses[0]!.label = 'a')],
    ['duplicate labels', (a: ReturnType<typeof base>) => void a.businesses.push({ ...a.businesses[0]!, domain: 'second.example.com', approvedHosts: ['second.example.com'] })],
    ['one host for two businesses', (a: ReturnType<typeof base>) => void a.businesses.push({ ...a.businesses[0]!, label: 'B' })],
    ['six businesses', (a: ReturnType<typeof base>) => void (a.businesses = Array.from({ length: 6 }, (_, i) => ({ ...a.businesses[0]!, label: `B${i}`, domain: `b${i}.example.com`, approvedHosts: [`b${i}.example.com`] })))],
    ['an approval dated in the future', (a: ReturnType<typeof base>) => void (a.approvedAt = '2026-11-19T10:00:00Z')],
    ['an expired approval', (a: ReturnType<typeof base>) => void (a.approvedAt = new Date(NOW.getTime() - (MAX_APPROVAL_AGE_DAYS + 1) * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z'))],
    ['a missing identity statement', (a: ReturnType<typeof base>) => void delete (a.businesses[0] as { operatorConfirmsIdentity?: boolean }).operatorConfirmsIdentity],
    ['not an object', () => 'approve everything'],
  ])('refuses %s', (_label, change) => {
    expect(bad(change as (a: ReturnType<typeof base>) => unknown)).toThrow();
  });
});

const NAV = '<nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/contact">Contact</a></nav>';
const HOME = html(`${NAV}<h1>Lab Heating Co</h1><p>Furnace repair for homeowners.</p><address>1 Test Road<br>Testville, MI 49999</address><p>Phone: (616) 555-0199</p><p>24/7 emergency service available.</p>`, 'Lab Heating Co');
const HOME_NO_LOCATION = html(`${NAV}<h1>Lab Heating Co</h1><p>Furnace repair for homeowners. Phone: (616) 555-0199</p>`, 'Lab Heating Co');
const SERVICES = html(`${NAV}<h1>Services</h1><p>Furnace repair. Phone: (616) 555-0199</p>`, 'Lab Heating Co | Services');
const CONTACT = html(`${NAV}<h1>Contact</h1><form action="/send" method="post"><input name="name"><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>`, 'Lab Heating Co | Contact');

const cert = makeTestCert('lab-heating-tls.example.com');
describe.skipIf(!cert)('operator live test, end to end, against a controlled TLS site', () => {
  const HOST = 'lab-heating-tls.example.com';
  const approvalsFor = (over: Record<string, unknown> = {}) =>
    parseApprovals(
      {
        purpose: 'Controlled test.',
        approvedBy: 'operator (test)',
        approvedAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z'),
        approvalRecord: 'Test fixture.',
        businesses: [
          { label: 'T', displayName: 'Lab Heating Co', city: 'Testville', state: 'MI', phone: '(616) 555-0199', domain: HOST, approvedHosts: [HOST], operatorConfirmsIdentity: false, selectionNote: 'Controlled site.', ...over },
          { label: 'OTHER', displayName: 'Other Co', city: 'Testville', state: 'MI', phone: null, domain: 'other-approved.example.com', approvedHosts: ['other-approved.example.com'], operatorConfirmsIdentity: false, selectionNote: 'Approved, but not the business being run.' },
        ],
      },
      new Date(),
    );

  async function tlsLab(home: string) {
    const l = await Lab.start();
    const posts: string[] = [];
    const site = await l.tlsSite(HOST, cert!, (req, res) => {
      if (req.method !== 'GET') posts.push(`${req.method} ${req.url}`);
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /admin\n');
      } else if (req.url === '/') sendHtml(res, home);
      else if (req.url === '/services') sendHtml(res, SERVICES);
      else if (req.url === '/contact') sendHtml(res, CONTACT);
      else sendHtml(res, html('Not found'), 404);
    });
    const other = await l.site('other-approved.example.com', (_req, res) => sendHtml(res, html('other')));
    return { l, site, other, posts };
  }
  const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oi-live-test-'));
  const fast = { minDelayMs: 5, timeoutMs: 2_000 };

  it('investigates the approved site, writes an internal report with the evidence trail, and approves nothing', async () => {
    const { l, site, other, posts } = await tlsLab(HOME);
    const dir = outDir();
    try {
      const result = await runLiveInvestigation({ approvals: approvalsFor(), label: 'T', outDir: dir, deps: { resolve: l.resolver, createRequest: l.requestFactory }, limits: fast });
      expect(result.status).toBe('review_ready');
      expect(result.summary.identityConfirmedBy).toBe('site_text');
      expect(site.hits.map((h) => `${h.method} ${h.path}`)).toEqual(['GET /robots.txt', 'GET /', 'GET /services', 'GET /contact']);
      expect(site.hits.every((h) => h.host === HOST && /OpportunityIntelligenceResearch/.test(h.userAgent))).toBe(true);
      // The form on /contact was read, never submitted. The other approved business was not touched.
      expect(posts).toEqual([]);
      expect(other.hits).toEqual([]);
      expect(l.lookupCount('other-approved.example.com')).toBe(0);
      expect(l.strayDials()).toEqual([]);
      expect(l.canary.hits).toEqual([]);

      const db = JSON.parse(fs.readFileSync(result.dataPath, 'utf8'));
      expect(db.runs[0].mode).toBe('live_test');
      expect(db.businesses[0].synthetic).toBe(false);
      expect(db.evidence.length).toBeGreaterThan(0);
      // Nothing was reviewed, accepted, approved, drafted or exported on the operator's behalf.
      expect(db.evidence.every((e: { verificationStatus: string; synthetic: boolean }) => e.verificationStatus === 'needs_review' && e.synthetic === false)).toBe(true);
      expect(db.opportunities.every((o: { decision: string }) => o.decision === 'pending')).toBe(true);
      expect(db.reports.every((r: { status: string }) => r.status === 'evidence_review')).toBe(true);
      expect(db.outreachDrafts).toEqual([]);
      expect(db.auditEvents.some((a: { action: string }) => /accepted|approved|exported|sent/.test(a.action))).toBe(false);

      const report = fs.readFileSync(result.reportPath, 'utf8');
      expect(report).toContain('Internal only. Unreviewed.');
      for (const p of ['/', '/services', '/contact']) expect(report).toContain(`https://${HOST}${p}`);
      for (const e of db.evidence) expect(report).toContain(e.id);
      expect(report).toContain('contact_form (presence)');
      expect(report).toContain('after_hours_statement (presence)');
      expect(report).toContain('booking_link (NOT FOUND on the pages listed)');
      expect(report).toMatch(/Review status: \*\*needs_review\*\*/);
      expect(report).toContain('robots.txt: read and applied');
      expect(report).toContain('## 7. Request log');
      expect(fs.existsSync(path.join(dir, 'reports', 'T-run-summary.json'))).toBe(true);
    } finally {
      await l.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at identity when the site does not confirm name and location, unless the operator stated it in the approval', async () => {
    const first = await tlsLab(HOME_NO_LOCATION);
    const dirA = outDir();
    try {
      const blocked = await runLiveInvestigation({ approvals: approvalsFor({ operatorConfirmsIdentity: false }), label: 'T', outDir: dirA, deps: { resolve: first.l.resolver, createRequest: first.l.requestFactory }, limits: fast });
      expect(blocked.status).toBe('blocked');
      expect(blocked.summary.identityConfirmedBy).toBe('not_confirmed');
      expect(first.site.hits.map((h) => h.path)).toEqual(['/robots.txt', '/']);
      expect(JSON.parse(fs.readFileSync(blocked.dataPath, 'utf8')).evidence).toEqual([]);
    } finally {
      await first.l.close();
      fs.rmSync(dirA, { recursive: true, force: true });
    }
    const second = await tlsLab(HOME_NO_LOCATION);
    const dirB = outDir();
    try {
      const confirmed = await runLiveInvestigation({ approvals: approvalsFor({ operatorConfirmsIdentity: true }), label: 'T', outDir: dirB, deps: { resolve: second.l.resolver, createRequest: second.l.requestFactory }, limits: fast });
      expect(confirmed.summary.identityConfirmedBy).toBe('operator');
      expect(confirmed.status).toBe('review_ready');
      // the home page was not requested a second time
      expect(second.site.hits.map((h) => h.path)).toEqual(['/robots.txt', '/', '/services', '/contact']);
      const db = JSON.parse(fs.readFileSync(confirmed.dataPath, 'utf8'));
      expect(db.businesses[0].identityStatus).toBe('confirmed_by_operator');
      expect(db.auditEvents.some((a: { action: string }) => a.action === 'business.identity_confirmed_manually')).toBe(true);
      expect(confirmed.markdown).toContain("NOT confirmed by the site's text; confirmed by the operator in the approval record");
    } finally {
      await second.l.close();
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('a label that is not in the approvals file makes no request', async () => {
    const { l, site } = await tlsLab(HOME);
    const dir = outDir();
    try {
      await expect(runLiveInvestigation({ approvals: approvalsFor(), label: 'NOPE', outDir: dir, deps: { resolve: l.resolver, createRequest: l.requestFactory }, limits: fast })).rejects.toThrow(/No approved business/);
      expect(site.hits).toEqual([]);
    } finally {
      await l.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the launcher and entry point refuse by default', () => {
  const launch = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['scripts/live-investigate.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const tmpApprovals = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-approvals-'));
    const file = path.join(dir, 'approvals.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        purpose: 'x',
        approvedBy: 'operator (test)',
        approvedAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z'),
        approvalRecord: 'x',
        businesses: [{ label: 'A', displayName: 'Lab Heating Co', city: 'Testville', state: 'MI', phone: null, domain: 'lab-heating.example.com', approvedHosts: ['lab-heating.example.com'], operatorConfirmsIdentity: false, selectionNote: 'x' }],
      }),
    );
    return { dir, file };
  };

  it('no arguments, a missing file, an unknown option or an unknown label: refused with exit code 2', () => {
    const { dir, file } = tmpApprovals();
    try {
      for (const args of [[], ['--approvals', path.join(dir, 'missing.json')], ['--approvals', file, '--allow-any-host'], ['--approvals', file, '--business', 'ZZ', '--confirm-live'], ['--approvals', file, '--confirm-live']]) {
        const run = launch(args);
        expect(run.status, args.join(' ')).toBe(2);
        expect(run.stderr).toContain('No request was made.');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without --confirm-live it only prints what it would contact', () => {
    const { dir, file } = tmpApprovals();
    try {
      const run = launch(['--approvals', file, '--business', 'A']);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('may reach: lab-heating.example.com');
      expect(run.stdout).toContain('nothing was requested');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an approvals file that git would track', () => {
    const file = path.join(process.cwd(), 'zz-approvals-not-ignored.json');
    fs.writeFileSync(file, JSON.stringify({ businesses: [{ label: 'A', approvedHosts: ['lab-heating.example.com'] }] }));
    try {
      const run = launch(['--approvals', file, '--business', 'A', '--confirm-live']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('not ignored by git');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('the entry point does nothing when it is run directly, without the launcher', () => {
    const vitestBin = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
    const env = { ...process.env };
    for (const key of ['OI_LIVE_CONFIRM', 'OI_LIVE_APPROVALS', 'OI_LIVE_BUSINESS', 'OI_LIVE_OUT']) delete env[key];
    const run = spawnSync(process.execPath, [vitestBin, 'run', '--config', 'tools/live-test/vitest.live.config.mts'], { encoding: 'utf8', env });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('No request was made.');
  }, 60_000);

  it('`npm test` does not include the live entry point, and the app configuration cannot select live test mode', () => {
    const testConfig = fs.readFileSync(path.join(process.cwd(), 'vitest.config.mts'), 'utf8');
    expect(testConfig).toContain("include: ['tests/**/*.test.ts']");
    for (const env of [{ APP_MODE: 'live_test' }, { APP_MODE: 'live' }, { OI_LIVE_CONFIRM: 'operator-approved-hosts-only' }, { NEXT_PUBLIC_APP_MODE: 'live_test', LIVE_FETCH_UNLOCKED: 'true' }]) {
      const config = loadConfig(env);
      expect(config.mode).toBe('mock');
      expect(config.liveFetchUnlocked).toBe(false);
    }
    expect(LIVE_TEST_LIMITS).toMatchObject({ maxPages: 5, maxRedirects: 3 });
  });

  it('only tools/live-test constructs the live transport; nothing in src/ or scripts/ does', () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|mts)$/.test(entry.name)) {
          const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
          if (rel.startsWith('tests/')) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (/createApprovedLiveTransport\s*\(|liveFetchUnlocked:\s*true|mode:\s*'live_test'/.test(text)) users.push(rel);
        }
      }
    };
    for (const dir of ['src', 'scripts', 'tools']) walk(path.join(process.cwd(), dir));
    expect(users.sort()).toEqual(['src/lib/security/safe-fetch.ts', 'tools/live-test/run.ts']);
  });
});
