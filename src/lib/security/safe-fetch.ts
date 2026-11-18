// Guarded HTTP GET for untrusted URLs.
//
// Per hop: validate URL -> resolve DNS -> require EVERY answer to be public ->
// connect to the validated address itself (pinning, so a second DNS answer
// cannot swap in a private address) -> never follow redirects automatically;
// each redirect target goes through the same checks and must stay on the
// site that was asked for.
//
// STATUS: exercised against controlled HTTP and TLS servers on this machine
// (tests/live-fetch-controlled.test.ts) and by unit tests with injected DNS
// (tests/ssrf.test.ts). It has NOT been used against real third-party sites,
// and the application never constructs it: see src/lib/runtime.ts and the
// lock in src/lib/services/investigations.ts.

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

export type RequestFailure = 'timeout' | 'malformed_response' | 'tls_error' | 'incomplete_response' | 'connection_failed';

/** A failed request, already sorted into a category. The message is the category; no socket detail leaves this module. */
export class PinnedRequestError extends Error {
  constructor(readonly failure: RequestFailure) {
    super(failure);
    this.name = 'PinnedRequestError';
  }
}

export type SafeFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /**
   * Hosts a redirect may land on. Default: only the host that was asked for,
   * with or without "www.". Anything else is reported as restricted and is
   * never requested.
   */
  isAllowedHost?: (host: string) => boolean;
};

export type SafeFetchDeps = { resolve: Resolver; request: PinnedRequest };

const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
/** Charsets that can be read here without a conversion library. Anything else is refused, not guessed. */
const UTF8_CHARSETS = new Set(['', 'utf-8', 'utf8', 'us-ascii', 'ascii']);
const LATIN1_CHARSETS = new Set(['iso-8859-1', 'latin1', 'windows-1252', 'cp1252']);

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

function classifyFailure(error: unknown): RequestFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (code.startsWith('HPE_')) return 'malformed_response';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('CERT_') ||
    code.includes('CERT') ||
    code === 'EPROTO' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  ) {
    return 'tls_error';
  }
  return 'connection_failed';
}

export type PinnedRequestOptions = {
  /**
   * TEST SEAM. Translates the address the fetcher decided to connect to into
   * the address of a controlled test server, the way a lab network would.
   * Everything before the socket (validation, DNS checks, pinning, Host header,
   * TLS server name) is unchanged. Never set in application code.
   */
  dial?: (to: { address: string; port: number; family: 4 | 6 }) => { address: string; port: number; family: 4 | 6 };
  /** Extra trusted certificate authority (PEM), for a controlled TLS test server. */
  ca?: string;
};

/** Sends one GET to the pinned address while keeping the original hostname for Host and SNI. */
export function createPinnedRequest(options: PinnedRequestOptions = {}): PinnedRequest {
  return (target) =>
    new Promise<RawResponse>((resolve, reject) => {
      const { url } = target;
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const wanted = { address: target.address, port: url.port ? Number(url.port) : isHttps ? 443 : 80, family: target.family };
      const socketTarget = options.dial ? options.dial(wanted) : wanted;
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
          port: socketTarget.port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          agent: false,
          // Never accept sloppy HTTP, and bound the header block.
          insecureHTTPParser: false,
          maxHeaderSize: 16_384,
          ...(isHttps ? { servername: url.hostname, rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) } : {}),
          headers: {
            host: url.host,
            'user-agent': target.userAgent,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
            'accept-encoding': 'identity',
          },
          // DNS pinning: never resolve again; always use the validated address.
          lookup: ((_hostname: string, lookupOptions: unknown, callback: unknown) => {
            const cb = (typeof lookupOptions === 'function' ? lookupOptions : callback) as (
              err: Error | null,
              address: string | ResolvedAddress[],
              family?: number,
            ) => void;
            const wantsAll = typeof lookupOptions === 'object' && lookupOptions !== null && (lookupOptions as { all?: boolean }).all;
            if (wantsAll) cb(null, [{ address: socketTarget.address, family: socketTarget.family }]);
            else cb(null, socketTarget.address, socketTarget.family);
          }) as never,
        },
        (res) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
            else if (Array.isArray(v) && v[0]) headers[k.toLowerCase()] = v[0];
          }
          const status = res.statusCode ?? 0;
          // A declared length over the cap is refused before any of the body is read.
          const declared = Number(headers['content-length']);
          if (Number.isFinite(declared) && declared > target.maxBytes) {
            req.destroy();
            finish(() => resolve({ status, headers, body: Buffer.alloc(0), truncated: true }));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > target.maxBytes) {
              req.destroy();
              finish(() => resolve({ status, headers, body: Buffer.alloc(0), truncated: true }));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            // "end" without a complete message means the server hung up part-way.
            if (!res.complete) finish(() => reject(new PinnedRequestError('incomplete_response')));
            else finish(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated: false }));
          });
          res.on('aborted', () => finish(() => reject(new PinnedRequestError('incomplete_response'))));
          res.on('error', (e) => finish(() => reject(new PinnedRequestError(classifyFailure(e) === 'connection_failed' ? 'incomplete_response' : classifyFailure(e)))));
        },
      );
      // One deadline for the whole exchange, so slow headers or a dripping body cannot extend it.
      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new PinnedRequestError('timeout')));
      }, target.timeoutMs);
      req.on('error', (e) => finish(() => reject(new PinnedRequestError(classifyFailure(e)))));
      req.end();
    });
}

export const nodePinnedRequest: PinnedRequest = createPinnedRequest();

function blocked(reason: string): FetchOutcome {
  return { kind: 'error', reason: `security_blocked:${reason}`, retryable: false };
}

const bareHost = (host: string) => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

type Decoded = { ok: true; text: string } | { ok: false; reason: string };

/** Turns the body into text only when that can be done faithfully. Never guesses an encoding. */
function decodeBody(body: Buffer, contentTypeHeader: string): Decoded {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentTypeHeader)?.[1]?.toLowerCase() ?? '';
  if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))) return { ok: false, reason: 'unsupported_charset' };
  if (body.includes(0)) return { ok: false, reason: 'binary_body' };
  if (UTF8_CHARSETS.has(charset)) {
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(body) };
    } catch {
      return { ok: false, reason: 'undecodable_body' };
    }
  }
  if (LATIN1_CHARSETS.has(charset)) return { ok: true, text: new TextDecoder('windows-1252').decode(body) };
  return { ok: false, reason: 'unsupported_charset' };
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions, deps: SafeFetchDeps): Promise<FetchOutcome> {
  const redirectChain: string[] = [];
  let current = rawUrl;
  let firstHost: string | null = null;
  let previousProtocol: string | null = null;

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const verdict = validateFetchUrl(current);
    if (!verdict.ok) return blocked(verdict.reason);
    const url = verdict.url;
    const host = url.hostname.toLowerCase();
    if (firstHost === null) firstHost = host;
    if (hop > 0) {
      const allowed = options.isAllowedHost ? options.isAllowedHost(host) : bareHost(host) === bareHost(firstHost);
      if (!allowed) return { kind: 'restricted', reason: 'redirected_off_domain', httpStatus: null };
      // A page asked for over TLS is never read over plain HTTP.
      if (previousProtocol === 'https:' && url.protocol === 'http:') return blocked('https_downgrade');
    }
    previousProtocol = url.protocol;

    let answers: ResolvedAddress[];
    try {
      answers = await deps.resolve(host);
    } catch {
      return { kind: 'unavailable', reason: 'dns_failure', httpStatus: null, retryable: true };
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      return { kind: 'unavailable', reason: 'dns_failure', httpStatus: null, retryable: true };
    }
    // Every answer must be public. A mixed answer set is refused outright.
    for (const answer of answers) {
      const addressVerdict = classifyAddress(String(answer?.address ?? ''));
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
      const failure: RequestFailure | 'unknown' = e instanceof PinnedRequestError ? e.failure : e instanceof Error && e.message === 'timeout' ? 'timeout' : 'unknown';
      if (failure === 'timeout') return { kind: 'error', reason: 'timeout', retryable: true };
      if (failure === 'malformed_response') return { kind: 'error', reason: 'malformed_response', retryable: false };
      if (failure === 'tls_error') return { kind: 'unavailable', reason: 'tls_error', httpStatus: null, retryable: false };
      if (failure === 'incomplete_response') return { kind: 'unavailable', reason: 'incomplete_response', httpStatus: null, retryable: true };
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

    const contentTypeHeader = res.headers['content-type'] ?? '';
    const contentType = contentTypeHeader.split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return { kind: 'error', reason: 'content_type_not_allowed', retryable: false };
    }
    // "identity" was requested. A compressed body would be read as noise and
    // then reported as a page with nothing on it, so it is refused instead.
    const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
    if (encoding !== '' && encoding !== 'identity') {
      return { kind: 'error', reason: 'unsupported_content_encoding', retryable: false };
    }
    const decoded = decodeBody(res.body, contentTypeHeader);
    if (!decoded.ok) return { kind: 'error', reason: decoded.reason, retryable: false };
    const body = decoded.text;
    // An empty page is not an inspected page.
    if (body.trim() === '') return { kind: 'unavailable', reason: 'empty_response', httpStatus: 200, retryable: false };
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

/**
 * Live transport. Present for Phase 2. The application does not construct it,
 * and investigations refuse any non-synthetic transport unless the in-memory
 * `liveFetchUnlocked` switch is set, which no environment variable can do.
 */
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
