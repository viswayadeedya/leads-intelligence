// Guarded HTTP GET for untrusted URLs.
//
// Per hop: validate URL -> resolve DNS -> require EVERY answer to be public ->
// connect to the validated address itself (pinning, so a second DNS answer
// cannot swap in a private address) -> never follow redirects automatically;
// each redirect target goes through the same checks.
//
// NOT LIVE-TESTED: this module is covered by unit tests with injected DNS and
// a loopback test server. It has not been used against real third-party sites.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { classifyAddress, validateFetchUrl } from './net-guard';
import type { FetchOutcome, PageTransport } from '../sources/transport';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type PinnedTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
};
export type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** true when the body exceeded maxBytes and the download was aborted */
  truncated: boolean;
};
export type PinnedRequest = (target: PinnedTarget) => Promise<RawResponse>;

export type SafeFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** Hosts a redirect may land on. Anything else is reported as restricted. */
  isAllowedHost?: (host: string) => boolean;
};

export type SafeFetchDeps = { resolve: Resolver; request: PinnedRequest };

const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Sends one GET to `address` while keeping the original hostname for Host/SNI. */
export const nodePinnedRequest: PinnedRequest = (target) =>
  new Promise<RawResponse>((resolve, reject) => {
    const { url, address, family } = target;
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        headers: {
          'user-agent': target.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
          'accept-encoding': 'identity',
        },
        // DNS pinning: never resolve again; always use the validated address.
        lookup: ((_hostname: string, options: unknown, callback: unknown) => {
          const cb = (typeof options === 'function' ? options : callback) as (
            err: Error | null,
            address: string | ResolvedAddress[],
            family?: number,
          ) => void;
          const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
          if (wantsAll) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as never,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
          else if (Array.isArray(v) && v[0]) headers[k.toLowerCase()] = v[0];
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > target.maxBytes) {
            req.destroy();
            finish(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.alloc(0), truncated: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(() =>
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated: false }),
          ),
        );
        res.on('error', (e) => finish(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error('timeout')));
    }, target.timeoutMs);
    req.on('error', (e) => finish(() => reject(e)));
    req.end();
  });

function blocked(reason: string): FetchOutcome {
  return { kind: 'error', reason: `security_blocked:${reason}`, retryable: false };
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions, deps: SafeFetchDeps): Promise<FetchOutcome> {
  const redirectChain: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const verdict = validateFetchUrl(current);
    if (!verdict.ok) return blocked(verdict.reason);
    const url = verdict.url;
    const host = url.hostname.toLowerCase();
    if (hop > 0 && options.isAllowedHost && !options.isAllowedHost(host)) {
      return { kind: 'restricted', reason: 'redirected_off_domain', httpStatus: null };
    }

    let answers: ResolvedAddress[];
    try {
      answers = await deps.resolve(host);
    } catch {
      return { kind: 'unavailable', reason: 'dns_failure', httpStatus: null, retryable: true };
    }
    if (answers.length === 0) {
      return { kind: 'unavailable', reason: 'dns_failure', httpStatus: null, retryable: true };
    }
    // Every answer must be public. A mixed answer set is refused outright.
    for (const answer of answers) {
      const addressVerdict = classifyAddress(answer.address);
      if (!addressVerdict.ok) return blocked(`dns_${addressVerdict.reason}`);
    }
    const pinned = answers[0]!;

    let res: RawResponse;
    try {
      res = await deps.request({
        url,
        address: pinned.address,
        family: pinned.family,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        userAgent: options.userAgent,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      if (message === 'timeout') return { kind: 'error', reason: 'timeout', retryable: true };
      return { kind: 'unavailable', reason: 'network_error', httpStatus: null, retryable: true };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers['location'];
      if (!location) return { kind: 'unavailable', reason: 'redirect_without_location', httpStatus: res.status, retryable: false };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return blocked('invalid_redirect');
      }
      redirectChain.push(url.toString());
      current = next.toString();
      continue;
    }

    if (res.truncated) return { kind: 'error', reason: 'response_too_large', retryable: false };

    if (res.status === 401 || res.status === 403 || res.status === 407 || res.status === 451) {
      return { kind: 'restricted', reason: `http_${res.status}`, httpStatus: res.status };
    }
    if (res.status === 429) return { kind: 'restricted', reason: 'rate_limited', httpStatus: 429 };
    if (res.status === 404 || res.status === 410) {
      return { kind: 'unavailable', reason: `http_${res.status}`, httpStatus: res.status, retryable: false };
    }
    if (res.status >= 500) {
      return { kind: 'unavailable', reason: `http_${res.status}`, httpStatus: res.status, retryable: true };
    }
    if (res.status !== 200) {
      return { kind: 'unavailable', reason: `unexpected_status_${res.status}`, httpStatus: res.status, retryable: false };
    }

    const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return { kind: 'error', reason: 'content_type_not_allowed', retryable: false };
    }
    const body = res.body.toString('utf8');
    // Stop at bot challenges; never try to get around them.
    if (/\b(captcha|cf-challenge|verify you are (a )?human)\b/i.test(body.slice(0, 20_000)) && body.length < 50_000) {
      return { kind: 'restricted', reason: 'captcha_or_bot_challenge', httpStatus: 200 };
    }
    return {
      kind: 'ok',
      finalUrl: url.toString(),
      httpStatus: 200,
      contentType,
      body,
      redirectChain,
      bytes: res.body.length,
    };
  }
  return { kind: 'unavailable', reason: 'too_many_redirects', httpStatus: null, retryable: false };
}

export const DEFAULT_USER_AGENT = 'OpportunityIntelligenceResearch/0.1 (single-operator research tool; honors robots.txt)';

/** Live transport. Present for Phase 2; not selectable in this mock-only build. */
export function createLiveTransport(
  options: Omit<SafeFetchOptions, 'userAgent'> & { userAgent?: string },
  deps: SafeFetchDeps = { resolve: systemResolver, request: nodePinnedRequest },
): PageTransport {
  return {
    id: 'live-http',
    synthetic: false,
    costCentsPerRequest: 0,
    fetchPage: (url) => safeFetch(url, { ...options, userAgent: options.userAgent ?? DEFAULT_USER_AGENT }, deps),
  };
}
