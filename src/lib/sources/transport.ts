// A PageTransport is the only way source adapters obtain page content.
// Mock mode uses bundled synthetic fixtures; the live transport wraps safeFetch.

export type FetchOutcome =
  | {
      kind: 'ok';
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      body: string;
      redirectChain: string[];
      bytes: number;
    }
  /** Access was refused (401/403/429, robots, CAPTCHA, off-domain redirect). Never retried automatically. */
  | { kind: 'restricted'; reason: string; httpStatus: number | null }
  /** The source did not provide the page (404, 5xx, DNS failure, no fixture). */
  | { kind: 'unavailable'; reason: string; httpStatus: number | null; retryable: boolean }
  /** Our side failed or refused (timeout, too large, wrong content type, security block). */
  | { kind: 'error'; reason: string; retryable: boolean };

export interface PageTransport {
  readonly id: string;
  /** true when content comes from bundled fictional fixtures */
  readonly synthetic: boolean;
  readonly costCentsPerRequest: number;
  /** Optional: lets a transport say up front that it has nothing for this host (mock fixtures). */
  canHandle?(host: string): boolean;
  /**
   * Required on every transport that makes real requests: the exact hostnames
   * the operator approved. An investigation refuses a non-synthetic transport
   * without it, and never asks it for a host that is not listed.
   */
  readonly approvedHosts?: readonly string[];
  fetchPage(url: string, attempt: number): Promise<FetchOutcome>;
}
