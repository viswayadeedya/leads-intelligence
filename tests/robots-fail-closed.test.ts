// Review finding 3: robots.txt handling fails closed.
//
// The rule, in one place (src/lib/sources/robots.ts) and used by both layers:
//
//   rules file read           -> its rules apply
//   empty file (HTTP 200)     -> a file with no rules: nothing is disallowed
//   genuinely absent          -> HTTP 404 or 410 only: nothing is disallowed
//   anything else             -> the rules are UNKNOWN and no page is requested
//
// "Anything else" is: 401/403/407/451, 429, a bot check, a redirect to another
// site, any other status, a server error, a timeout, a dropped connection, an
// oversized or non-text response, a web page answering for /robots.txt.
//
// Every case below is exercised twice against controlled servers on this
// machine (tests/lab; no request leaves it):
//   - the INVESTIGATION layer, which reads robots.txt of the address it starts from;
//   - the TRANSPORT layer, which reads robots.txt of an approved origin before
//     following a redirect to it.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '@/lib/context';
import { createApprovedLiveTransport } from '@/lib/security/safe-fetch';
import { createBusiness } from '@/lib/services/businesses';
import { retryFailedSources, startInvestigation } from '@/lib/services/investigations';
import { robotsPolicyFromState, robotsRefusalReason, robotsStateFromOutcome, type RobotsRefusal } from '@/lib/sources/robots';
import type { FetchOutcome, PageTransport } from '@/lib/sources/transport';
import { html, Lab, redirect, sendHtml } from './lab/controlled-net';
import { activeEv, liveOpps, makeCtx } from './helpers';

let lab: Lab;
beforeAll(async () => {
  lab = await Lab.start();
});
afterAll(async () => {
  await lab.close();
});

let n = 0;
const name = (label: string) => `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${++n}.example.com`;
const OPTS = { timeoutMs: 400, maxBytes: 20_000, maxRedirects: 3, minDelayMs: 0, maxWireRequests: 30 };
const net = () => ({ resolve: lab.resolver, createRequest: lab.requestFactory });

const BUSINESS = { displayName: 'Lab Heating Co', city: 'Testville', state: 'MI', phone: '(616) 555-0199' };
const NAV = '<nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/contact">Contact</a></nav>';
const HOME = html(`${NAV}<h1>Lab Heating Co</h1><p>Furnace repair.</p><address>1 Test Road<br>Testville, MI 49999</address><p>Phone: (616) 555-0199</p>`, 'Lab Heating Co');
const SERVICES = html(`${NAV}<h1>Services</h1><p>Furnace repair. Phone: (616) 555-0199</p>`, 'Lab Heating Co | Services');
const CONTACT = html(`${NAV}<h1>Contact</h1><p>Phone: (616) 555-0199</p>`, 'Lab Heating Co | Contact');

type Res = http.ServerResponse;
const text = (body: string, status = 200, type = 'text/plain') => (res: Res) => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};
const status = (code: number) => (res: Res) => sendHtml(res, html(`<h1>${code}</h1>`), code);

type Expected = { status: 'ok' | 'none' | 'unreachable'; reason: string; retryable?: boolean };
type Case = {
  label: string;
  /** how the site answers GET /robots.txt */
  robots: (res: Res, ctx: { host: string; elsewhere: string }) => void;
  state: Expected;
  /** the reason recorded on pages that were not requested; null when pages may be requested */
  refusal: RobotsRefusal | null;
  /** requests the site sees beyond /robots.txt while robots.txt is being read (its own redirect) */
  alsoSeen?: string[];
};

const UNKNOWN: Case[] = [
  // --- access restricted ---
  { label: 'HTTP 401', robots: status(401), state: { status: 'unreachable', reason: 'access_refused', retryable: false }, refusal: 'robots_restricted' },
  { label: 'HTTP 403', robots: status(403), state: { status: 'unreachable', reason: 'access_refused', retryable: false }, refusal: 'robots_restricted' },
  { label: 'HTTP 407', robots: status(407), state: { status: 'unreachable', reason: 'access_refused', retryable: false }, refusal: 'robots_restricted' },
  { label: 'HTTP 451', robots: status(451), state: { status: 'unreachable', reason: 'access_refused', retryable: false }, refusal: 'robots_restricted' },
  { label: 'HTTP 429 rate limited', robots: status(429), state: { status: 'unreachable', reason: 'rate_limited', retryable: false }, refusal: 'robots_restricted' },
  {
    label: 'a bot check page',
    robots: (res) => sendHtml(res, html('<h1>Just a moment</h1><p>Verify you are human to continue.</p>')),
    state: { status: 'unreachable', reason: 'bot_challenge', retryable: false },
    refusal: 'robots_restricted',
  },
  // --- redirected ---
  {
    label: 'a redirect to another site',
    robots: (res, { elsewhere }) => redirect(res, `http://${elsewhere}/robots.txt`, 301),
    state: { status: 'unreachable', reason: 'redirected_elsewhere', retryable: false },
    refusal: 'robots_restricted',
  },
  {
    label: 'a redirect to the home page',
    robots: (res) => redirect(res, '/', 302),
    state: { status: 'unreachable', reason: 'not_a_robots_file', retryable: false },
    refusal: 'robots_invalid',
    // Following robots.txt's own redirect is part of reading it. What came back is discarded, not used as evidence.
    alsoSeen: ['/'],
  },
  { label: 'a redirect loop', robots: (res) => redirect(res, '/robots.txt', 302), state: { status: 'unreachable', reason: 'fetch_failed', retryable: false }, refusal: 'robots_unreachable', alsoSeen: ['/robots.txt', '/robots.txt', '/robots.txt'] },
  { label: 'a redirect with no Location', robots: (res) => { res.writeHead(302); res.end(); }, state: { status: 'unreachable', reason: 'unexpected_status', retryable: false }, refusal: 'robots_invalid' },
  // --- not a rules file ---
  { label: 'a web page with HTTP 200 (soft 404)', robots: (res) => sendHtml(res, html('<h1>Page not found</h1>')), state: { status: 'unreachable', reason: 'not_a_robots_file', retryable: false }, refusal: 'robots_invalid' },
  { label: 'a web page labelled text/plain', robots: text('<!doctype html><html><body>Sign in</body></html>'), state: { status: 'unreachable', reason: 'not_a_robots_file', retryable: false }, refusal: 'robots_invalid' },
  { label: 'a PDF', robots: text('%PDF-1.4 ...', 200, 'application/pdf'), state: { status: 'unreachable', reason: 'not_a_robots_file', retryable: false }, refusal: 'robots_invalid' },
  { label: 'HTTP 400', robots: status(400), state: { status: 'unreachable', reason: 'unexpected_status', retryable: false }, refusal: 'robots_invalid' },
  { label: 'HTTP 418', robots: status(418), state: { status: 'unreachable', reason: 'unexpected_status', retryable: false }, refusal: 'robots_invalid' },
  { label: 'HTTP 204', robots: (res) => { res.writeHead(204); res.end(); }, state: { status: 'unreachable', reason: 'unexpected_status', retryable: false }, refusal: 'robots_invalid' },
  // --- unreachable ---
  { label: 'HTTP 500', robots: status(500), state: { status: 'unreachable', reason: 'server_error', retryable: true }, refusal: 'robots_unreachable' },
  { label: 'HTTP 502', robots: status(502), state: { status: 'unreachable', reason: 'server_error', retryable: true }, refusal: 'robots_unreachable' },
  { label: 'HTTP 503', robots: status(503), state: { status: 'unreachable', reason: 'server_error', retryable: true }, refusal: 'robots_unreachable' },
  { label: 'no answer before the timeout', robots: () => undefined, state: { status: 'unreachable', reason: 'fetch_failed', retryable: true }, refusal: 'robots_unreachable' },
  { label: 'a dropped connection', robots: (res) => res.socket?.destroy(), state: { status: 'unreachable', reason: 'fetch_failed', retryable: true }, refusal: 'robots_unreachable' },
  { label: 'a response over the size limit', robots: text(`User-agent: *\n${'# padding\n'.repeat(4_000)}`), state: { status: 'unreachable', reason: 'fetch_failed', retryable: false }, refusal: 'robots_unreachable' },
  { label: 'a compressed body that was not asked for', robots: (res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end('not really gzip'); }, state: { status: 'unreachable', reason: 'fetch_failed', retryable: false }, refusal: 'robots_unreachable' },
];

const KNOWN: Case[] = [
  { label: 'HTTP 404 (genuinely absent)', robots: status(404), state: { status: 'none', reason: 'absent' }, refusal: null },
  { label: 'HTTP 410 (genuinely absent)', robots: status(410), state: { status: 'none', reason: 'absent' }, refusal: null },
  { label: 'an empty file', robots: text(''), state: { status: 'ok', reason: 'empty' }, refusal: null },
  { label: 'a rules file that allows everything', robots: text('User-agent: *\nAllow: /\n'), state: { status: 'ok', reason: 'read' }, refusal: null },
  { label: 'a rules file with only comments', robots: text('# nothing to see\n'), state: { status: 'ok', reason: 'read' }, refusal: null },
];

/** A site whose pages are healthy; only /robots.txt varies. `www.` is the same server. */
async function siteWith(c: Case, pages: Record<string, string> = { '/': HOME, '/services': SERVICES, '/contact': CONTACT }) {
  const host = name(c.label);
  const elsewhere = name('elsewhere');
  const elsewhereSite = await lab.site(elsewhere, (_req, res) => text('User-agent: *\nAllow: /\n')(res));
  const site = await lab.site(host, (req, res) => {
    if (req.url === '/robots.txt') return c.robots(res, { host, elsewhere });
    const body = pages[req.url ?? ''];
    return body ? sendHtml(res, body) : sendHtml(res, html('Not found'), 404);
  });
  return { host, site, elsewhere, elsewhereSite };
}

/**
 * The approved-host transport over the lab network. The lab sites are plain HTTP, so
 * the address is rewritten on the way out and back; the investigation sees an https site.
 */
function approvedTransport(hosts: string[]): PageTransport & { log: { url: string; detail: string }[] } {
  const inner = createApprovedLiveTransport({ ...OPTS, approvedHosts: hosts }, net());
  return {
    ...inner,
    log: inner.log,
    fetchPage: async (url, attempt) => {
      const out = await inner.fetchPage(url.replace(/^https:/, 'http:'), attempt);
      return out.kind === 'ok' ? { ...out, finalUrl: out.finalUrl.replace(/^http:/, 'https:') } : out;
    },
  };
}
const ctxFor = (hosts: string[], config: Partial<Ctx['config']> = {}): Ctx => makeCtx({ transport: approvedTransport(hosts), config: { liveFetchUnlocked: true, ...config } });

describe('the one rule: from a response to a policy', () => {
  const allowed = (outcome: FetchOutcome, path = '/contact') => robotsPolicyFromState(robotsStateFromOutcome(outcome)).isAllowed(path);
  const ok = (body: string, contentType = 'text/plain'): FetchOutcome => ({ kind: 'ok', finalUrl: 'https://x.example.com/robots.txt', httpStatus: 200, contentType, body, redirectChain: [], bytes: body.length });

  it('rules that were read are applied; an empty or absent file disallows nothing', () => {
    expect(allowed(ok('User-agent: *\nDisallow: /contact\n'))).toBe(false);
    expect(allowed(ok('User-agent: *\nDisallow: /contact\n'), '/services')).toBe(true);
    expect(allowed({ kind: 'unavailable', reason: 'empty_response', httpStatus: 200, retryable: false })).toBe(true);
    expect(allowed({ kind: 'unavailable', reason: 'http_404', httpStatus: 404, retryable: false })).toBe(true);
    expect(allowed({ kind: 'unavailable', reason: 'http_410', httpStatus: 410, retryable: false })).toBe(true);
  });

  const unknown: [string, FetchOutcome][] = [
    ['401', { kind: 'restricted', reason: 'http_401', httpStatus: 401 }],
    ['403', { kind: 'restricted', reason: 'http_403', httpStatus: 403 }],
    ['429', { kind: 'restricted', reason: 'rate_limited', httpStatus: 429 }],
    ['bot check', { kind: 'restricted', reason: 'captcha_or_bot_challenge', httpStatus: 200 }],
    ['redirect elsewhere', { kind: 'restricted', reason: 'redirected_off_domain', httpStatus: null }],
    ['blocked by another origin\'s robots.txt', { kind: 'restricted', reason: 'robots_disallow', httpStatus: null }],
    ['400', { kind: 'unavailable', reason: 'unexpected_status_400', httpStatus: 400, retryable: false }],
    ['500', { kind: 'unavailable', reason: 'http_500', httpStatus: 500, retryable: true }],
    ['dns failure', { kind: 'unavailable', reason: 'dns_failure', httpStatus: null, retryable: true }],
    ['tls error', { kind: 'unavailable', reason: 'tls_error', httpStatus: null, retryable: false }],
    ['network error', { kind: 'unavailable', reason: 'network_error', httpStatus: null, retryable: true }],
    ['too many redirects', { kind: 'unavailable', reason: 'too_many_redirects', httpStatus: null, retryable: false }],
    ['timeout', { kind: 'error', reason: 'timeout', retryable: true }],
    ['malformed response', { kind: 'error', reason: 'malformed_response', retryable: false }],
    ['too large', { kind: 'error', reason: 'response_too_large', retryable: false }],
    ['wrong content type', { kind: 'error', reason: 'content_type_not_allowed', retryable: false }],
    ['refused by a security rule', { kind: 'error', reason: 'security_blocked:dns_private_address', retryable: false }],
    ['an HTML page', ok('<!doctype html><html><body>Welcome</body></html>', 'text/html')],
    ['an HTML fragment as text/plain', ok('  <div>Not found</div>')],
    ['text followed by a script tag', ok('Welcome to our site\n<script>location.href="/"</script>')],
  ];
  it.each(unknown)('%s -> rules unknown -> every path refused', (_label, outcome) => {
    const state = robotsStateFromOutcome(outcome);
    expect(state.status).toBe('unreachable');
    expect(state.text).toBeNull();
    const policy = robotsPolicyFromState(state);
    for (const path of ['/', '/contact', '/services', '/anything/else']) expect(policy.isAllowed(path)).toBe(false);
    expect(robotsRefusalReason(state)).toMatch(/^robots_(?:restricted|invalid|unreachable)$/);
  });

  it('a status this code has never seen is still "unknown", never "absent"', () => {
    for (const code of [200, 201, 202, 206, 300, 305, 400, 402, 405, 406, 408, 409, 411, 421, 426, 428, 431, 499]) {
      const state = robotsStateFromOutcome({ kind: 'unavailable', reason: `unexpected_status_${code}`, httpStatus: code, retryable: false });
      if (code === 200) continue; // 200 with an 'unavailable' outcome is only ever the empty body, covered above
      expect(state.status, String(code)).toBe('unreachable');
    }
  });
});

describe('investigation layer, against controlled servers', () => {
  describe.each(UNKNOWN)('robots.txt answers with $label', (c) => {
    it('no page is requested, nothing is observed, and the reason is recorded', async () => {
      const { host, site, elsewhere, elsewhereSite } = await siteWith(c);
      const ctx = ctxFor([host]);
      const run = await startInvestigation(ctx, { businessId: createBusiness(ctx, { ...BUSINESS, domain: host }).id });
      const db = ctx.store.snapshot();

      // The site saw the request for robots.txt (and its own redirect, if any) and nothing else.
      expect(site.hits.map((h) => h.path)).toEqual(['/robots.txt', ...(c.alsoSeen ?? [])]);
      expect(site.hits.every((h) => h.method === 'GET')).toBe(true);
      // A redirect to another site is reported, never followed.
      expect(elsewhereSite.hits).toEqual([]);
      expect(lab.lookupCount(elsewhere)).toBe(0);

      expect(run.robots).toMatchObject({ ...c.state, text: null });
      const records = db.sourceRecords.filter((r) => r.runId === run.id);
      expect(records.length).toBeGreaterThan(0);
      for (const r of records) {
        expect(r.accessStatus, r.sourceUrl ?? '').toBe('restricted');
        expect(r.extracted ?? null).toBeNull();
      }
      const home = records.find((r) => r.queryContext.path === '/')!;
      const expectedDetail = { robots_restricted: /refused or limited access to robots\.txt, so its rules are unknown/, robots_invalid: /did not come back as a readable rules file, so its rules are unknown/, robots_unreachable: /robots\.txt could not be read, so access was not assumed/, robots_disallow: /never/ }[c.refusal!];
      expect(home.accessDetail).toMatch(expectedDetail);

      // Not having looked is not a finding: no observation, no "not found", no claim.
      expect(activeEv(db, run.id)).toEqual([]);
      expect(liveOpps(db, run.id)).toEqual([]);
      expect(run.unknowns.map((u) => u.kind)).toEqual(['website_not_inspected']);
      expect(['partial', 'blocked']).toContain(run.status);
      expect(lab.strayDials()).toEqual([]);
    });
  });

  describe.each(KNOWN)('robots.txt answers with $label', (c) => {
    it('pages are requested', async () => {
      const { host, site } = await siteWith(c);
      const ctx = ctxFor([host]);
      const run = await startInvestigation(ctx, { businessId: createBusiness(ctx, { ...BUSINESS, domain: host }).id });
      expect(run.robots).toMatchObject(c.state);
      expect(site.hits.map((h) => h.path)).toEqual(['/robots.txt', '/', '/services', '/contact']);
      expect(run.status).toBe('review_ready');
    });
  });

  it('rules that were read are obeyed: a disallowed page is never requested', async () => {
    const c: Case = { label: 'disallow contact', robots: text('User-agent: *\nDisallow: /contact\n'), state: { status: 'ok', reason: 'read' }, refusal: null };
    const { host, site } = await siteWith(c);
    const ctx = ctxFor([host]);
    const run = await startInvestigation(ctx, { businessId: createBusiness(ctx, { ...BUSINESS, domain: host }).id });
    expect(site.hits.map((h) => h.path)).toEqual(['/robots.txt', '/', '/services']);
    const contact = ctx.store.snapshot().sourceRecords.find((r) => r.runId === run.id && r.queryContext.path === '/contact')!;
    expect(contact).toMatchObject({ accessStatus: 'restricted', accessDetail: 'Not fetched: disallowed by robots.txt' });
    // A page that was not read cannot support "not found".
    expect(activeEv(ctx.store.snapshot(), run.id).filter((e) => e.polarity === 'absence')).toEqual([]);
  });

  it('"Disallow: /" is obeyed: only robots.txt is ever requested', async () => {
    const c: Case = { label: 'disallow all', robots: text('User-agent: *\nDisallow: /\n'), state: { status: 'ok', reason: 'read' }, refusal: 'robots_disallow' };
    const { host, site } = await siteWith(c);
    const ctx = ctxFor([host]);
    const run = await startInvestigation(ctx, { businessId: createBusiness(ctx, { ...BUSINESS, domain: host }).id });
    expect(site.hits.map((h) => h.path)).toEqual(['/robots.txt']);
    expect(activeEv(ctx.store.snapshot(), run.id)).toEqual([]);
  });

  it('a robots.txt redirected within the same site is read where it lands, and its rules apply', async () => {
    const host = name('same-site-redirect');
    const site = await lab.site(host, (req, res) => {
      if (req.url === '/robots.txt') return redirect(res, '/robots-file.txt', 301);
      if (req.url === '/robots-file.txt') return text('User-agent: *\nDisallow: /contact\n')(res);
      const body = { '/': HOME, '/services': SERVICES, '/contact': CONTACT }[req.url ?? ''];
      return body ? sendHtml(res, body) : sendHtml(res, html('Not found'), 404);
    });
    const ctx = ctxFor([host]);
    const run = await startInvestigation(ctx, { businessId: createBusiness(ctx, { ...BUSINESS, domain: host }).id });
    expect(run.robots).toMatchObject({ status: 'ok', reason: 'read' });
    expect(site.hits.map((h) => h.path)).toEqual(['/robots.txt', '/robots-file.txt', '/', '/services']);
  });

  it('a refusal is never asked again; a server error may be retried once the operator asks, and only then are pages read', async () => {
    // refused: nothing to retry
    const refused = await siteWith(UNKNOWN.find((c) => c.label === 'HTTP 403')!);
    const ctxA = ctxFor([refused.host]);
    const runA = await startInvestigation(ctxA, { businessId: createBusiness(ctxA, { ...BUSINESS, domain: refused.host }).id });
    await expect(retryFailedSources(ctxA, runA.id)).rejects.toThrow();
    expect(refused.site.hits.map((h) => h.path)).toEqual(['/robots.txt']);

    // rate limited: not retried either. The site asked for fewer requests, not more.
    const limited = await siteWith(UNKNOWN.find((c) => c.label === 'HTTP 429 rate limited')!);
    const ctxB = ctxFor([limited.host]);
    const runB = await startInvestigation(ctxB, { businessId: createBusiness(ctxB, { ...BUSINESS, domain: limited.host }).id });
    await expect(retryFailedSources(ctxB, runB.id)).rejects.toThrow();
    expect(limited.site.hits.map((h) => h.path)).toEqual(['/robots.txt']);

    // server error, then healthy
    let healthy = false;
    const flaky = await siteWith({ label: 'flaky', robots: (res) => (healthy ? text('User-agent: *\nDisallow: /contact\n')(res) : status(503)(res)), state: { status: 'unreachable', reason: 'server_error' }, refusal: 'robots_unreachable' });
    // A fresh transport per attempt, as a new supervised run would have; within one run the first answer is kept.
    const store = makeCtx().store;
    const ctxC = makeCtx({ store, transport: approvedTransport([flaky.host]), config: { liveFetchUnlocked: true } });
    const runC = await startInvestigation(ctxC, { businessId: createBusiness(ctxC, { ...BUSINESS, domain: flaky.host }).id });
    expect(runC.robots).toMatchObject({ status: 'unreachable', reason: 'server_error', retryable: true });
    expect(runC.status).toBe('partial');
    expect(flaky.site.hits.map((h) => h.path)).toEqual(['/robots.txt']);
    healthy = true;
    const ctxD = makeCtx({ store, transport: approvedTransport([flaky.host]), config: { liveFetchUnlocked: true } });
    const retried = await retryFailedSources(ctxD, runC.id);
    expect(retried.robots).toMatchObject({ status: 'ok', reason: 'read' });
    // the rules now known are obeyed
    expect(flaky.site.hits.map((h) => h.path)).toEqual(['/robots.txt', '/robots.txt', '/', '/services']);
  });
});

describe('transport layer: robots.txt of an origin reached by redirect, against controlled servers', () => {
  /** `host` redirects everything to `www.host`; only www's /robots.txt varies. */
  async function redirectingSite(c: Case) {
    const host = name(`apex-${c.label}`);
    const www = `www.${host}`;
    const elsewhere = name('elsewhere');
    const elsewhereSite = await lab.site(elsewhere, (_req, res) => text('User-agent: *\nAllow: /\n')(res));
    const site = await lab.site(host, (req, res) => {
      if (req.headers.host === host) return redirect(res, `http://${www}${req.url}`, 301);
      if (req.url === '/robots.txt') return c.robots(res, { host: www, elsewhere });
      return sendHtml(res, html(`<h1>${req.url}</h1>`));
    });
    lab.setDns(www, [{ address: site.ip, family: 4 }]);
    const wwwHits = () => site.hits.filter((h) => h.host === www).map((h) => h.path);
    return { host, www, site, wwwHits, elsewhere, elsewhereSite };
  }

  describe.each(UNKNOWN)('the target origin answers /robots.txt with $label', (c) => {
    it('the redirect is not followed and no page is requested from that origin', async () => {
      const { host, www, wwwHits, elsewhere, elsewhereSite } = await redirectingSite(c);
      const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host, www] }, net());
      const out = await transport.fetchPage(`http://${host}/contact`, 0);
      expect(out).toMatchObject({ kind: 'restricted', reason: c.refusal, redirectedTo: `http://${www}` });
      // robots.txt was asked for (with its own redirect, if any, on that same host); the page never was
      expect(wwwHits()).not.toContain('/contact');
      expect(wwwHits()[0]).toBe('/robots.txt');
      expect(wwwHits().filter((p) => p !== '/robots.txt' && !(c.alsoSeen ?? []).includes(p))).toEqual([]);
      expect(elsewhereSite.hits).toEqual([]);
      expect(lab.lookupCount(elsewhere)).toBe(0);
      // the same answer is kept for the rest of the run: the origin is not asked again
      const again = wwwHits().length;
      expect(await transport.fetchPage(`http://${host}/services`, 0)).toMatchObject({ kind: 'restricted', reason: c.refusal });
      expect(wwwHits().length).toBe(again);
      expect(transport.log.some((l) => /rules unknown \(.+\), nothing fetched/.test(l.detail))).toBe(true);
    });
  });

  describe.each(KNOWN)('the target origin answers /robots.txt with $label', (c) => {
    it('the redirect is followed', async () => {
      const { host, www, wwwHits } = await redirectingSite(c);
      const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host, www] }, net());
      expect(await transport.fetchPage(`http://${host}/contact`, 0)).toMatchObject({ kind: 'ok', finalUrl: `http://${www}/contact` });
      expect(wwwHits()).toEqual(['/robots.txt', '/contact']);
    });
  });

  it('redirect-origin checks are unchanged: a robots.txt that points at an unapproved host is never followed there', async () => {
    const host = name('robots-points-away');
    const away = name('unapproved');
    const awaySite = await lab.site(away, (_req, res) => text('User-agent: *\nAllow: /\n')(res));
    const site = await lab.site(host, (req, res) => (req.url === '/robots.txt' ? redirect(res, `http://${away}/robots.txt`, 301) : sendHtml(res, HOME)));
    const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host] }, net());
    const out = await transport.fetchPage(`http://${host}/robots.txt`, 0);
    expect(out).toMatchObject({ kind: 'restricted', reason: 'redirected_off_domain', redirectedTo: `http://${away}` });
    expect(robotsStateFromOutcome(out)).toMatchObject({ status: 'unreachable', reason: 'redirected_elsewhere' });
    expect(awaySite.hits).toEqual([]);
    expect(lab.lookupCount(away)).toBe(0);
    expect(site.hits.map((h) => h.path)).toEqual(['/robots.txt']);
  });

  it('a target origin whose robots.txt redirects to a third approved host is treated as unknown: its rules must come from itself', async () => {
    const host = name('apex-chain');
    const www = `www.${host}`;
    const third = name('third-approved');
    const thirdSite = await lab.site(third, (_req, res) => text('User-agent: *\nAllow: /\n')(res));
    const site = await lab.site(host, (req, res) => {
      if (req.headers.host === host) return redirect(res, `http://${www}${req.url}`, 301);
      if (req.url === '/robots.txt') return redirect(res, `http://${third}/robots.txt`, 301);
      return sendHtml(res, HOME);
    });
    lab.setDns(www, [{ address: site.ip, family: 4 }]);
    const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host, www, third] }, net());
    expect(await transport.fetchPage(`http://${host}/`, 0)).toMatchObject({ kind: 'restricted', reason: 'robots_restricted' });
    expect(thirdSite.hits).toEqual([]);
    expect(site.hits.filter((h) => h.host === www).map((h) => h.path)).toEqual(['/robots.txt']);
  });

  it('a robots.txt that redirects to some other file on another origin does not replace that origin\'s own rules', async () => {
    const host = name('apex-notes');
    const www = `www.${host}`;
    const site = await lab.site(host, (req, res) => {
      if (req.headers.host === host) return req.url === '/robots.txt' ? redirect(res, `http://${www}/notes.txt`, 301) : redirect(res, `http://${www}${req.url}`, 301);
      if (req.url === '/robots.txt') return text('User-agent: *\nDisallow: /private\n')(res);
      if (req.url === '/notes.txt') return text('just some notes\n')(res);
      return sendHtml(res, html(`<h1>${req.url}</h1>`));
    });
    lab.setDns(www, [{ address: site.ip, family: 4 }]);
    const wwwHits = () => site.hits.filter((h) => h.host === www).map((h) => h.path);
    const transport = createApprovedLiveTransport({ ...OPTS, approvedHosts: [host, www] }, net());
    // www's real robots.txt is read before the redirect to /notes.txt is followed
    expect(await transport.fetchPage(`http://${host}/robots.txt`, 0)).toMatchObject({ kind: 'ok', finalUrl: `http://${www}/notes.txt` });
    expect(wwwHits()).toEqual(['/robots.txt', '/notes.txt']);
    // ...and it stays in force for www afterwards
    expect(await transport.fetchPage(`http://${host}/private/prices`, 0)).toMatchObject({ kind: 'restricted', reason: 'robots_disallow' });
    expect(await transport.fetchPage(`http://${host}/contact`, 0)).toMatchObject({ kind: 'ok' });
    expect(wwwHits()).toEqual(['/robots.txt', '/notes.txt', '/contact']);
  });

  it('through the whole investigation: a site that moves to "www." whose robots.txt is refused yields no page and no observation', async () => {
    const c = UNKNOWN.find((x) => x.label === 'HTTP 403')!;
    const host = name('moved-and-refused');
    const www = `www.${host}`;
    const site = await lab.site(host, (req, res) => {
      if (req.headers.host === host) return req.url === '/robots.txt' ? status(404)(res) : redirect(res, `http://${www}${req.url}`, 301);
      if (req.url === '/robots.txt') return c.robots(res, { host: www, elsewhere: 'unused.example.com' });
      return sendHtml(res, HOME);
    });
    lab.setDns(www, [{ address: site.ip, family: 4 }]);
    const ctx = ctxFor([host, www]);
    const run = await startInvestigation(ctx, { businessId: createBusiness(ctx, { ...BUSINESS, domain: host }).id });
    const db = ctx.store.snapshot();
    // apex: robots.txt absent (404), so the home page is asked for; it redirects to www, whose rules are refused
    expect(site.hits.map((h) => `${h.host === www ? 'www' : 'apex'} ${h.path}`)).toEqual(['apex /robots.txt', 'apex /', 'www /robots.txt']);
    expect(activeEv(db, run.id)).toEqual([]);
    expect(liveOpps(db, run.id)).toEqual([]);
    const home = db.sourceRecords.find((r) => r.runId === run.id && r.queryContext.path === '/')!;
    expect(home.accessStatus).toBe('restricted');
    expect(home.accessDetail).toMatch(/refused or limited access to robots\.txt/);
    expect(run.unknowns.map((u) => u.kind)).toEqual(['website_not_inspected']);
  });
});
