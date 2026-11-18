// Mock transport: serves bundled FICTIONAL fixtures. Makes no network calls.

import { findCaseByDomain } from '@/fixtures/golden';
import type { FetchOutcome, PageTransport } from './transport';

export class MockFixtureTransport implements PageTransport {
  readonly id = 'mock-fixture';
  readonly synthetic = true;
  readonly costCentsPerRequest = 0;

  canHandle(host: string): boolean {
    return findCaseByDomain(host.replace(/^www\./, '')) !== null;
  }

  async fetchPage(url: string, attempt: number): Promise<FetchOutcome> {
    const u = new URL(url);
    const golden = findCaseByDomain(u.hostname.replace(/^www\./, ''));
    if (!golden) return { kind: 'unavailable', reason: 'mock_fixture_missing', httpStatus: null, retryable: false };
    const path = u.pathname.replace(/\/+$/, '') || '/';

    if (path === '/robots.txt') {
      if (golden.robotsTxt === undefined) {
        return { kind: 'unavailable', reason: 'http_404', httpStatus: 404, retryable: false };
      }
      return {
        kind: 'ok',
        finalUrl: url,
        httpStatus: 200,
        contentType: 'text/plain',
        body: golden.robotsTxt,
        redirectChain: [],
        bytes: golden.robotsTxt.length,
      };
    }

    const page = golden.pages[path];
    if (!page) return { kind: 'unavailable', reason: 'http_404', httpStatus: 404, retryable: false };
    if (page.status === 'timeout_then_ok') {
      if (attempt < page.failures) return { kind: 'error', reason: 'timeout', retryable: true };
      return ok(url, page.html);
    }
    if (page.status === 200) return ok(url, page.html);
    if (page.status === 401 || page.status === 403) {
      return { kind: 'restricted', reason: `http_${page.status}`, httpStatus: page.status };
    }
    if (page.status === 429) return { kind: 'restricted', reason: 'rate_limited', httpStatus: 429 };
    if (page.status === 404) return { kind: 'unavailable', reason: 'http_404', httpStatus: 404, retryable: false };
    return { kind: 'unavailable', reason: `http_${page.status}`, httpStatus: page.status, retryable: true };
  }
}

function ok(url: string, html: string): FetchOutcome {
  return {
    kind: 'ok',
    finalUrl: url,
    httpStatus: 200,
    contentType: 'text/html',
    body: html,
    redirectChain: [],
    bytes: Buffer.byteLength(html, 'utf8'),
  };
}
