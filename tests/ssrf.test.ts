// SECURITY_PROTOCOL required negative test 4:
// "URL fetch rejects localhost, 127.0.0.1, 169.254.169.254, private IPv4/IPv6,
//  redirect-to-private, rebinding attempts, file:// and oversized responses."

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyAddress, expandIPv6, validateFetchUrl } from '@/lib/security/net-guard';
import { nodePinnedRequest, safeFetch, type PinnedRequest, type RawResponse, type Resolver } from '@/lib/security/safe-fetch';

const OPTS = { timeoutMs: 1000, maxBytes: 2000, maxRedirects: 2, userAgent: 'test-agent' };
const html = (body: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }): RawResponse => ({
  status,
  headers,
  body: Buffer.from(body),
  truncated: false,
});
const publicDns: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('validateFetchUrl', () => {
  const rejected: [string, string][] = [
    ['file:///etc/passwd', 'scheme_not_allowed'],
    ['ftp://example.com/', 'scheme_not_allowed'],
    ['javascript:alert(1)', 'scheme_not_allowed'],
    ['gopher://example.com/', 'scheme_not_allowed'],
    ['http://localhost/', 'internal_hostname'],
    ['http://LOCALHOST./', 'internal_hostname'],
    ['http://app.localhost/', 'internal_hostname'],
    ['http://printer.local/', 'internal_hostname'],
    ['http://db.internal/', 'internal_hostname'],
    ['http://intranet/', 'single_label_hostname'],
    ['http://127.0.0.1/', 'non_public_ipv4'],
    ['http://127.1/', 'non_public_ipv4'],
    ['http://2130706433/', 'non_public_ipv4'],
    ['http://0x7f.0.0.1/', 'non_public_ipv4'],
    ['http://0177.0.0.1/', 'non_public_ipv4'],
    ['http://0.0.0.0/', 'non_public_ipv4'],
    ['http://169.254.169.254/latest/meta-data/', 'non_public_ipv4'],
    ['http://10.0.0.5/', 'non_public_ipv4'],
    ['http://172.16.4.1/', 'non_public_ipv4'],
    ['http://192.168.1.1/', 'non_public_ipv4'],
    ['http://100.64.0.1/', 'non_public_ipv4'],
    ['http://[::1]/', 'non_public_ipv6_form'],
    ['http://[::ffff:127.0.0.1]/', 'non_public_ipv6_form'],
    ['http://[::ffff:7f00:1]/', 'non_public_ipv6_form'],
    ['http://[fd00::1]/', 'non_public_ipv6'],
    ['http://[fe80::1]/', 'non_public_ipv6'],
    ['http://[64:ff9b::7f00:1]/', 'non_public_ipv6'],
    ['http://8.8.8.8/', 'ip_literal_not_allowed'],
    ['http://user:pw@example.com/', 'embedded_credentials'],
    ['http://example.com:8080/', 'port_not_allowed'],
    ['https://example.com:22/', 'port_not_allowed'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
  ];
  it.each(rejected)('rejects %s (%s)', (url, reason) => {
    const verdict = validateFetchUrl(url);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe(reason);
  });

  it('accepts ordinary public http and https URLs', () => {
    expect(validateFetchUrl('https://example.com/contact?x=1').ok).toBe(true);
    expect(validateFetchUrl('http://www.example.co.uk/').ok).toBe(true);
  });
});

describe('classifyAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.31.255.255', '192.168.0.10', '169.254.169.254', '0.0.0.0', '100.100.100.100', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::abcd', '::ffff:10.0.0.1', '::ffff:a00:1', '2001:db8::1', '2002:7f00:1::', 'ff02::1', 'not-an-ip'])(
    'refuses %s',
    (addr) => expect(classifyAddress(addr).ok).toBe(false),
  );
  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e'])('allows public %s', (addr) =>
    expect(classifyAddress(addr).ok).toBe(true),
  );
  it('expands IPv6 forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIPv6('1.2.3.4')).toBeNull();
  });
});

describe('safeFetch', () => {
  it('blocks a hostname whose DNS answer is private, without connecting', async () => {
    let connected = false;
    const out = await safeFetch('https://internal-alias.example.com/', OPTS, {
      resolve: async () => [{ address: '10.0.0.7', family: 4 }],
      request: async () => {
        connected = true;
        return html('secret');
      },
    });
    expect(out).toMatchObject({ kind: 'error', reason: 'security_blocked:dns_non_public_ipv4' });
    expect(connected).toBe(false);
  });

  it('blocks when ANY DNS answer is private (mixed answer set)', async () => {
    const out = await safeFetch('https://mixed.example.com/', OPTS, {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
      request: async () => html('x'),
    });
    expect(out.kind).toBe('error');
  });

  it('blocks redirect to the cloud metadata address', async () => {
    const seen: string[] = [];
    const out = await safeFetch('https://site.example.com/', OPTS, {
      resolve: publicDns,
      request: async (t) => {
        seen.push(t.url.toString());
        return html('', 302, { location: 'http://169.254.169.254/latest/meta-data/' });
      },
    });
    expect(out).toMatchObject({ kind: 'error', reason: 'security_blocked:non_public_ipv4' });
    expect(seen).toEqual(['https://site.example.com/']);
  });

  it('blocks redirect to localhost, to file:// and to a host that resolves privately', async () => {
    // The third target is on the same site (redirects elsewhere are not followed at all),
    // but its name resolves to a private address.
    for (const location of ['http://localhost/admin', 'file:///etc/passwd', 'https://www.site.example.com/']) {
      const out = await safeFetch('https://site.example.com/', OPTS, {
        resolve: async (host) => (host === 'www.site.example.com' ? [{ address: '192.168.1.20', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]),
        request: async () => html('', 301, { location }),
      });
      expect(out.kind).toBe('error');
      if (out.kind === 'error') expect(out.reason.startsWith('security_blocked')).toBe(true);
    }
  });

  it('by default a redirect to a different site is not followed and that site is never resolved', async () => {
    const resolved: string[] = [];
    const out = await safeFetch('https://site.example.com/', OPTS, {
      resolve: async (host) => {
        resolved.push(host);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      request: async () => html('', 301, { location: 'https://rebind.example.net/' }),
    });
    expect(out).toMatchObject({ kind: 'restricted', reason: 'redirected_off_domain' });
    expect(resolved).toEqual(['site.example.com']);
  });

  it('defeats DNS rebinding: connects to the validated address and never resolves a second time', async () => {
    let lookups = 0;
    const targets: string[] = [];
    const rebinding: Resolver = async () => {
      lookups++;
      // first answer is public; any later answer would be the attacker's private address
      return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    };
    const request: PinnedRequest = async (t) => {
      targets.push(t.address);
      return html('<html><title>ok</title></html>');
    };
    const out = await safeFetch('https://rebind.example.com/', OPTS, { resolve: rebinding, request });
    expect(out.kind).toBe('ok');
    expect(lookups).toBe(1);
    expect(targets).toEqual(['93.184.216.34']);
  });

  it('caps redirects', async () => {
    const out = await safeFetch('https://loop.example.com/', OPTS, {
      resolve: publicDns,
      request: async (t) => html('', 302, { location: `${t.url.pathname}x` }),
    });
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'too_many_redirects' });
  });

  it('reports off-domain redirects as restricted instead of following them', async () => {
    const out = await safeFetch('https://biz.example.com/', { ...OPTS, isAllowedHost: (h) => h.endsWith('biz.example.com') }, {
      resolve: publicDns,
      request: async () => html('', 302, { location: 'https://social.example.org/biz' }),
    });
    expect(out).toMatchObject({ kind: 'restricted', reason: 'redirected_off_domain' });
  });

  it('refuses oversized responses and non-HTML content', async () => {
    const big = await safeFetch('https://big.example.com/', OPTS, {
      resolve: publicDns,
      request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.alloc(0), truncated: true }),
    });
    expect(big).toMatchObject({ kind: 'error', reason: 'response_too_large' });
    const pdf = await safeFetch('https://pdf.example.com/', OPTS, {
      resolve: publicDns,
      request: async () => html('%PDF', 200, { 'content-type': 'application/pdf' }),
    });
    expect(pdf).toMatchObject({ kind: 'error', reason: 'content_type_not_allowed' });
  });

  it('maps 403/429/CAPTCHA to restricted and never retries them', async () => {
    for (const [status, body] of [
      [403, 'Forbidden'],
      [429, 'Too many'],
      [200, '<html>Please complete the CAPTCHA to continue</html>'],
    ] as const) {
      const out = await safeFetch('https://guarded.example.com/', OPTS, { resolve: publicDns, request: async () => html(body, status) });
      expect(out.kind).toBe('restricted');
    }
  });
});

describe('nodePinnedRequest (real sockets against a loopback test server)', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(50_000));
      } else if (req.url === '/slow') {
        // never responds
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`host=${req.headers.host}`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const target = (path: string) => ({
    url: new URL(`http://pinned-host.example.invalid:${port}${path}`),
    address: '127.0.0.1',
    family: 4 as const,
    timeoutMs: 400,
    maxBytes: 5000,
    userAgent: 'test-agent',
  });

  it('connects to the pinned address even though the hostname does not resolve', async () => {
    const res = await nodePinnedRequest(target('/'));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(`host=pinned-host.example.invalid:${port}`);
  });

  it('aborts when the body exceeds the byte cap', async () => {
    const res = await nodePinnedRequest(target('/big'));
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it('times out instead of hanging', async () => {
    await expect(nodePinnedRequest(target('/slow'))).rejects.toThrow('timeout');
  });

  it('safeFetch refuses the same loopback server when addressed directly', async () => {
    const out = await safeFetch(`http://127.0.0.1:${port}/`, OPTS, { resolve: publicDns, request: nodePinnedRequest });
    expect(out.kind).toBe('error');
  });
});
