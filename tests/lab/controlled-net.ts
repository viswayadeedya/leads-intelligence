// A controlled network for exercising the guarded fetcher with real sockets.
//
// Every "site" is a real HTTP, HTTPS or raw TCP server on 127.0.0.1. Test
// hostnames resolve (through the lab's own resolver) to public-looking
// addresses, and the fetcher's test seam translates those addresses to the
// local servers, the way a lab router would. Validation, DNS checks, pinning,
// redirect handling, limits and parsing all run exactly as in production.
//
// Anything the fetcher tries to connect to that is NOT a registered site
// (a private address, the metadata address, loopback) is routed to the
// "canary": a server standing in for an internal service. A correct fetcher
// never reaches it, so every test can assert canary.hits === 0.
//
// No request ever leaves this machine.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPinnedRequest, type PinnedRequest, type PinnedRequestOptions, type ResolvedAddress, type Resolver, type SafeFetchDeps } from '@/lib/security/safe-fetch';

export type Hit = { method: string; path: string; host: string; userAgent: string };
export type Site = { host: string; ip: string; port: number; hits: Hit[] };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type DnsAnswer = ResolvedAddress[] | Error;

export type TestCert = { key: string; cert: string };

/** A throwaway self-signed certificate made with OpenSSL. Null when OpenSSL is not installed. */
export function makeTestCert(hostname: string): TestCert | null {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', '/usr/bin/openssl'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-lab-cert-'));
  try {
    for (const bin of candidates) {
      try {
        execFileSync(
          bin,
          ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`],
          { stdio: 'ignore', timeout: 20_000 },
        );
        return { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
      } catch {
        // try the next location
      }
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class Lab {
  private readonly closers: (() => Promise<void>)[] = [];
  private readonly nat = new Map<string, number>();
  private readonly dns = new Map<string, DnsAnswer | ((call: number) => DnsAnswer)>();
  private readonly dnsCalls = new Map<string, number>();
  private nextIp = 10;
  private closedPort = 0;
  private ca: string | undefined;

  /** every address:port the fetcher opened a socket to, in order */
  readonly dialed: string[] = [];
  /** every hostname the fetcher resolved, in order */
  readonly lookups: string[] = [];
  /** stands in for an internal service; must never be reached */
  canary: Site = { host: 'canary', ip: '', port: 0, hits: [] };

  static async start(): Promise<Lab> {
    const lab = new Lab();
    lab.canary = await lab.listenHttp('canary.internal', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>INTERNAL-CANARY-SECRET</title><body>internal admin</body></html>');
    });
    // A port with nothing listening, for "connection refused".
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    lab.closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return lab;
  }

  private record(hits: Hit[], req: http.IncomingMessage): void {
    hits.push({ method: req.method ?? '', path: req.url ?? '', host: req.headers.host ?? '', userAgent: String(req.headers['user-agent'] ?? '') });
  }

  private async listenHttp(host: string, handler: Handler): Promise<Site> {
    const site: Site = { host, ip: '', port: 0, hits: [] };
    const server = http.createServer((req, res) => {
      this.record(site.hits, req);
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site.port = (server.address() as AddressInfo).port;
    this.closers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    return site;
  }

  private publish(site: Site, port: 80 | 443): Site {
    site.ip = `93.184.216.${this.nextIp++}`;
    this.nat.set(`${site.ip}:${port}`, site.port);
    this.dns.set(site.host, [{ address: site.ip, family: 4 }]);
    return site;
  }

  /** A public website served over plain HTTP. */
  async site(host: string, handler: Handler): Promise<Site> {
    return this.publish(await this.listenHttp(host, handler), 80);
  }

  /** A public website served over TLS with the given certificate. */
  async tlsSite(host: string, cert: TestCert, handler: Handler, trust = true): Promise<Site> {
    const site: Site = { host, ip: '', port: 0, hits: [] };
    const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      this.record(site.hits, req);
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site.port = (server.address() as AddressInfo).port;
    this.closers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    if (trust) this.ca = cert.cert;
    return this.publish(site, 443);
  }

  /** A "website" that speaks raw TCP, for responses no HTTP library would produce. */
  async rawSite(host: string, onConnection: (socket: net.Socket, firstBytes: Buffer) => void): Promise<Site> {
    const site: Site = { host, ip: '', port: 0, hits: [] };
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.once('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        site.hits.push({ method: 'RAW', path: data.toString('latin1').split('\r\n')[0] ?? '', host, userAgent: '' });
        onConnection(socket, data);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site.port = (server.address() as AddressInfo).port;
    this.closers.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    });
    return this.publish(site, 80);
  }

  /** A hostname that resolves publicly but has nothing listening. */
  deadSite(host: string): void {
    const ip = `93.184.216.${this.nextIp++}`;
    this.nat.set(`${ip}:80`, this.closedPort);
    this.dns.set(host, [{ address: ip, family: 4 }]);
  }

  /** Overrides DNS for a hostname. A function receives the 1-based call number (for rebinding). */
  setDns(host: string, answer: DnsAnswer | ((call: number) => DnsAnswer)): void {
    this.dns.set(host.toLowerCase(), answer);
  }

  readonly resolver: Resolver = async (hostname) => {
    const host = hostname.toLowerCase();
    this.lookups.push(host);
    const call = (this.dnsCalls.get(host) ?? 0) + 1;
    this.dnsCalls.set(host, call);
    const entry = this.dns.get(host);
    const answer = typeof entry === 'function' ? entry(call) : entry;
    if (answer === undefined) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    if (answer instanceof Error) throw answer;
    return answer;
  };

  get request(): PinnedRequest {
    return createPinnedRequest({
      ca: this.ca,
      dial: (to) => {
        this.dialed.push(`${to.address}:${to.port}`);
        const local = this.nat.get(`${to.address}:${to.port}`);
        // Unregistered destination: it lands on the canary, which must stay untouched.
        return { address: '127.0.0.1', port: local ?? this.canary.port, family: 4 };
      },
    });
  }

  /** Builds a socket layer with the caller's options (for example an approved-host list) plus the lab's translation. */
  readonly requestFactory = (options: PinnedRequestOptions): PinnedRequest =>
    createPinnedRequest({
      ...options,
      ca: this.ca,
      dial: (to) => {
        this.dialed.push(`${to.address}:${to.port}`);
        const local = this.nat.get(`${to.address}:${to.port}`);
        return { address: '127.0.0.1', port: local ?? this.canary.port, family: 4 };
      },
    });

  get deps(): SafeFetchDeps {
    return { resolve: this.resolver, request: this.request };
  }

  /** Sockets opened to anything that is not a registered public test site. Must always be empty. */
  strayDials(): string[] {
    return this.dialed.filter((d) => !this.nat.has(d));
  }

  lookupCount(host: string): number {
    return this.lookups.filter((h) => h === host.toLowerCase()).length;
  }

  async close(): Promise<void> {
    await Promise.all(this.closers.map((c) => c()));
  }
}

export const html = (body: string, title = 'Lab page') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export function sendHtml(res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export function redirect(res: http.ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { location });
  res.end();
}
