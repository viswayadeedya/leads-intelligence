// Guarded HTTP GET for untrusted URLs.
//
// Per hop: validate URL -> resolve DNS -> require EVERY answer to be public ->
// connect to the validated address itself (pinning, so a second DNS answer
// cannot swap in a private address) -> never follow redirects automatically;
// each redirect target goes through the same checks and must stay on the
// site that was asked for.
//
// STATUS: exercised against controlled HTTP and TLS servers on this machine
// (tests/live-fetch-controlled.test.ts, tests/live-approved-hosts.test.ts) and
// by unit tests with injected DNS (tests/ssrf.test.ts). The web application
// never constructs it (src/lib/runtime.ts). The only way to make a real request
// is the operator live test in tools/live-test, which can reach nothing but
// hostnames the operator approved, exactly, in advance.
//
// LAYERS. An address is checked three times, by three separate pieces of code:
//   1. the transport refuses any URL whose host is not on the approved list;
//   2. safeFetch validates the URL, every DNS answer and every redirect hop;
//   3. the socket layer (createPinnedRequest) refuses, at connect time, any
//      host not on the approved list, any non-public address and any port
//      other than 80/443, and checks the peer address after connecting.
// All three are in this process. There is NO operating-system or network
// firewall rule behind them; see docs/delivery/DECISIONS.md ADR-024.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { classifyAddress, validateFetchUrl } from './net-guard';
import { robotsPolicyFromState, robotsRefusalReason, robotsStateFromOutcome, type RobotsRefusal, type RobotsState } from '../sources/robots';
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

export type RequestFailure = 'timeout' | 'malformed_response' | 'tls_error' | 'incomplete_response' | 'connection_failed' | 'egress_refused';

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
  /**
   * Hosts for which a page asked for over HTTPS may be read over plain HTTP
   * when the site itself redirects there. Default: none. Set only when the
   * operator approved plain HTTP for that exact hostname.
   */
  allowPlainHttp?: (host: string) => boolean;
  /**
   * Called before a redirect that leaves the current origin (scheme + host) is
   * followed, so the new origin's robots.txt can be read first. Anything other
   * than 'allow' stops the fetch; the target is then never requested.
   */
  beforeCrossOrigin?: (next: URL) => Promise<'allow' | RobotsRefusal>;
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
  /**
   * Exact hostnames this socket layer may connect to. When set, anything else
   * is refused here, whatever the caller validated or failed to validate.
   */
  approvedHosts?: ReadonlySet<string>;
  /** Called for every HTTP request actually put on the wire (each redirect hop is one). */
  onRequest?: (info: { hostname: string; address: string; port: number }) => void;
};

/**
 * Connect-time egress check. Independent of URL validation: it looks at the
 * literal address and port about to be dialled. Returns a reason, or null.
 */
export function egressRefusal(to: { hostname: string; address: string; port: number }, approvedHosts?: ReadonlySet<string>): string | null {
  if (to.port !== 80 && to.port !== 443) return 'port';
  if (!classifyAddress(to.address).ok) return 'address';
  if (approvedHosts && !approvedHosts.has(to.hostname.toLowerCase().replace(/\.$/, ''))) return 'host';
  return null;
}

/** Sends one GET to the pinned address while keeping the original hostname for Host and SNI. */
export function createPinnedRequest(options: PinnedRequestOptions = {}): PinnedRequest {
  return (target) =>
    new Promise<RawResponse>((resolve, reject) => {
      const { url } = target;
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const wanted = { address: target.address, port: url.port ? Number(url.port) : isHttps ? 443 : 80, family: target.family };
      // Egress check on the address the fetcher decided on, before anything is dialled.
      if (egressRefusal({ hostname: url.hostname, address: wanted.address, port: wanted.port }, options.approvedHosts)) {
        reject(new PinnedRequestError('egress_refused'));
        return;
      }
      options.onRequest?.({ hostname: url.hostname, address: wanted.address, port: wanted.port });
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
      // After connecting, the peer must be the address that was pinned. Anything else is dropped unread.
      req.on('socket', (socket) => {
        const check = () => {
          const peer = (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
          if (peer !== '' && peer !== socketTarget.address.replace(/^::ffff:/, '')) {
            req.destroy();
            finish(() => reject(new PinnedRequestError('egress_refused')));
          }
        };
        if (socket.connecting) socket.once('connect', check);
        else check();
      });
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
  let previousOrigin: string | null = null;

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const verdict = validateFetchUrl(current);
    if (!verdict.ok) return blocked(verdict.reason);
    const url = verdict.url;
    const host = url.hostname.toLowerCase();
    if (firstHost === null) firstHost = host;
    if (hop > 0) {
      const allowed = options.isAllowedHost ? options.isAllowedHost(host) : bareHost(host) === bareHost(firstHost);
      // Reported so the operator can see where the site points. The target is not resolved or requested.
      const redirectedTo = `${url.protocol}//${host}`;
      if (!allowed) return { kind: 'restricted', reason: 'redirected_off_domain', httpStatus: null, redirectedTo };
      // A page asked for over TLS is not read over plain HTTP, unless the operator approved that for this host.
      if (previousProtocol === 'https:' && url.protocol === 'http:' && !(options.allowPlainHttp && options.allowPlainHttp(host))) {
        return { kind: 'error', reason: 'security_blocked:https_downgrade', retryable: false, redirectedTo };
      }
    }
    if (hop > 0 && previousOrigin !== null && url.origin !== previousOrigin && options.beforeCrossOrigin) {
      const verdict = await options.beforeCrossOrigin(url);
      if (verdict !== 'allow') return { kind: 'restricted', reason: verdict, httpStatus: null, redirectedTo: `${url.protocol}//${host}` };
    }
    previousProtocol = url.protocol;
    previousOrigin = url.origin;

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
      if (failure === 'egress_refused') return blocked('egress_refused');
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

export type RequestLogEntry = {
  at: string;
  url: string;
  outcome: FetchOutcome['kind'] | 'refused';
  detail: string;
  httpStatus: number | null;
  bytes: number | null;
  ms: number;
  /** HTTP requests actually sent for this page, redirects included */
  wireRequests: number;
};

export type ApprovedLiveOptions = {
  /** Exact hostnames, as approved by the operator. No wildcards, no "www." added for you. */
  approvedHosts: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /**
   * Approved hostnames that may be read over plain HTTP when the site redirects
   * HTTPS there. Must be a subset of approvedHosts. Default: none.
   */
  plainHttpHosts?: readonly string[];
  /** minimum pause between two requests to the same host */
  minDelayMs: number;
  /** hard ceiling on HTTP requests put on the wire, across all hosts, for this transport */
  maxWireRequests: number;
  userAgent?: string;
};

export type ApprovedLiveDeps = {
  resolve: Resolver;
  /** builds the socket layer; tests substitute one that dials controlled local servers */
  createRequest: (options: PinnedRequestOptions) => PinnedRequest;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export const MAX_APPROVED_HOSTS = 10;

/** Returns the cleaned list, or throws naming the entry that is not an exact public hostname. */
export function validateApprovedHosts(hosts: readonly string[]): string[] {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('No approved hostnames were given. A live test needs at least one exact hostname.');
  if (hosts.length > MAX_APPROVED_HOSTS) throw new Error(`Too many approved hostnames (${hosts.length}). This test mode allows at most ${MAX_APPROVED_HOSTS}.`);
  const out: string[] = [];
  for (const raw of hosts) {
    const host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    // Exact names only: letters, digits, dots and hyphens. No scheme, path, port, wildcard or address.
    if (!/^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
      throw new Error(`"${String(raw).slice(0, 80)}" is not an exact hostname (for example "example.com").`);
    }
    const verdict = validateFetchUrl(`https://${host}/`);
    if (!verdict.ok) throw new Error(`"${host}" cannot be approved: ${verdict.reason}.`);
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * The only transport that makes real requests. It can reach the approved
 * hostnames and nothing else: not their subdomains, not the sites they link or
 * redirect to. GET only; no cookies, no credentials, no form submission.
 */
export function createApprovedLiveTransport(
  options: ApprovedLiveOptions,
  deps: Partial<ApprovedLiveDeps> = {},
): PageTransport & { readonly approvedHosts: readonly string[]; readonly log: RequestLogEntry[]; readonly wireRequests: () => number } {
  const approved = validateApprovedHosts(options.approvedHosts);
  const approvedSet: ReadonlySet<string> = new Set(approved);
  const plainHttp = new Set((options.plainHttpHosts ?? []).map((h) => String(h).trim().toLowerCase()));
  for (const host of plainHttp) if (!approvedSet.has(host)) throw new Error(`"${host}" is marked for plain HTTP but is not an approved hostname.`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const resolve = deps.resolve ?? systemResolver;
  let wire = 0;
  const request = (deps.createRequest ?? createPinnedRequest)({
    approvedHosts: approvedSet,
    onRequest: () => {
      wire++;
    },
  });
  // The ceiling is enforced where requests are sent, so redirect hops count too.
  const capped: PinnedRequest = (target) => {
    if (wire >= options.maxWireRequests) return Promise.reject(new PinnedRequestError('egress_refused'));
    return request(target);
  };
  const lastRequestAt = new Map<string, number>();
  const log: RequestLogEntry[] = [];
  const fetchOptions = {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    // A redirect may only land on another approved hostname (for example the "www." form, if it was approved).
    isAllowedHost: (h: string) => approvedSet.has(h.toLowerCase()),
    allowPlainHttp: (h: string) => plainHttp.has(h.toLowerCase()),
  };
  const pause = async (host: string): Promise<void> => {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = options.minDelayMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
  };

  // robots.txt belongs to an origin. The investigation reads it for the address it starts
  // from; when the site redirects to another approved origin (for example "www."), that
  // origin's robots.txt is read here, before the redirect is followed.
  const robotsByOrigin = new Map<string, RobotsState>();
  /** robots.txt responses already obtained in this run, so no origin is asked for it twice */
  const robotsOutcomeByOrigin = new Map<string, FetchOutcome>();
  // Same rule as the investigation layer (one shared function): only a genuinely absent
  // robots.txt allows everything; any refusal or error leaves the rules unknown.
  const rememberRobots = (origin: string, res: FetchOutcome): void => {
    robotsByOrigin.set(origin, robotsStateFromOutcome(res));
    robotsOutcomeByOrigin.set(origin, res);
  };
  const beforeCrossOrigin = async (next: URL): Promise<'allow' | RobotsRefusal> => {
    // Reading a robots.txt is always permitted; it is how the rules are learned.
    if (next.pathname === '/robots.txt') return 'allow';
    let policy = robotsByOrigin.get(next.origin);
    if (policy === undefined) {
      const started = now();
      const before = wire;
      await pause(next.hostname.toLowerCase());
      const robotsUrl = `${next.origin}/robots.txt`;
      // Same guards as any page. Its own redirects must stay on this exact host.
      const res = await safeFetch(robotsUrl, { ...fetchOptions, maxRedirects: 1, isAllowedHost: (h: string) => h.toLowerCase() === next.hostname.toLowerCase() }, { resolve, request: capped });
      lastRequestAt.set(next.hostname.toLowerCase(), now());
      rememberRobots(next.origin, res);
      policy = robotsByOrigin.get(next.origin)!;
      log.push({
        at: new Date(started).toISOString(),
        url: robotsUrl,
        outcome: res.kind,
        detail: `robots.txt of the redirect target: ${res.kind === 'ok' ? `HTTP ${res.httpStatus}` : res.reason}; rules ${policy.status === 'ok' ? 'read' : policy.status === 'none' ? 'absent, nothing disallowed' : `unknown (${policy.reason ?? 'not determined'}), nothing fetched`}`,
        httpStatus: 'httpStatus' in res ? res.httpStatus : null,
        bytes: res.kind === 'ok' ? res.bytes : null,
        ms: now() - started,
        wireRequests: wire - before,
      });
    }
    return robotsPolicyFromState(policy).isAllowed(next.pathname || '/') ? 'allow' : robotsRefusalReason(policy);
  };

  return {
    id: 'live-approved-hosts',
    synthetic: false,
    costCentsPerRequest: 0,
    approvedHosts: approved,
    log,
    wireRequests: () => wire,
    canHandle: (host) => approvedSet.has(host.toLowerCase()),
    async fetchPage(url) {
      const started = now();
      const before = wire;
      const record = (outcome: FetchOutcome | null, detail: string): void => {
        log.push({
          at: new Date(started).toISOString(),
          url,
          outcome: outcome ? outcome.kind : 'refused',
          detail,
          httpStatus: outcome && 'httpStatus' in outcome ? outcome.httpStatus : null,
          bytes: outcome && outcome.kind === 'ok' ? outcome.bytes : null,
          ms: now() - started,
          wireRequests: wire - before,
        });
      };
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        record(null, 'invalid_url');
        return blocked('invalid_url');
      }
      // Layer 1: nothing is resolved or requested for a host that is not on the list.
      if (!approvedSet.has(host)) {
        record(null, 'host_not_approved');
        return blocked('host_not_approved');
      }
      const asked = new URL(url);
      const isRobots = asked.pathname === '/robots.txt';
      const known = isRobots ? robotsOutcomeByOrigin.get(asked.origin) : undefined;
      if (known) {
        record(known, 'robots.txt already read in this run; not requested again');
        return known;
      }
      await pause(host);
      const outcome = await safeFetch(url, { ...fetchOptions, beforeCrossOrigin }, { resolve, request: capped });
      if (isRobots) {
        rememberRobots(asked.origin, outcome);
        // If it was served as the robots.txt of another origin of the site, it is that origin's
        // robots.txt too. Only then: a redirect to some other file there says nothing about
        // that origin's rules and must not replace them.
        if (outcome.kind === 'ok') {
          const served = new URL(outcome.finalUrl);
          if (served.origin !== asked.origin && served.pathname === '/robots.txt') rememberRobots(served.origin, outcome);
        }
      }
      lastRequestAt.set(host, now());
      const pointedAt = outcome.kind !== 'ok' && 'redirectedTo' in outcome && outcome.redirectedTo ? `; redirect pointed at ${outcome.redirectedTo} (not requested)` : '';
      record(outcome, outcome.kind === 'ok' ? `HTTP ${outcome.httpStatus}; final ${outcome.finalUrl}` : `${outcome.reason}${pointedAt}`);
      return outcome;
    },
  };
}
