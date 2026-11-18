// URL and address validation for outbound fetches (SSRF defense).
// Rules come from docs/security/SECURITY_PROTOCOL.md "Safe fetching and SSRF defense".
// This is application-layer defense; egress network restrictions are still
// required before live mode (not implemented in this build).

import net from 'node:net';

const blockedV4 = new net.BlockList();
const V4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [addr, prefix] of V4_RANGES) blockedV4.addSubnet(addr, prefix, 'ipv4');

const blockedV6 = new net.BlockList();
const V6_RANGES: [string, number][] = [
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments incl. Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
for (const [addr, prefix] of V6_RANGES) blockedV6.addSubnet(addr, prefix, 'ipv6');

/** Expand an IPv6 literal to 8 groups. Returns null if it is not valid IPv6. */
export function expandIPv6(input: string): number[] | null {
  let addr = input;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (!net.isIPv6(addr)) return null;
  // Convert an embedded dotted IPv4 tail into two hex groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
    const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) =>
    parseInt(g, 16),
  );
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

export type AddressVerdict = { ok: true } | { ok: false; reason: string };

/** True only for globally routable unicast addresses. Unknown or odd forms are refused. */
export function classifyAddress(address: string): AddressVerdict {
  if (net.isIPv4(address)) {
    return blockedV4.check(address, 'ipv4')
      ? { ok: false, reason: 'non_public_ipv4' }
      : { ok: true };
  }
  const groups = expandIPv6(address);
  if (!groups) return { ok: false, reason: 'not_an_ip_address' };
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  // ::, ::1, IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d) forms
  // are never legitimate public web hosts; refuse them all.
  if (firstFiveZero && (groups[5] === 0 || groups[5] === 0xffff)) {
    return { ok: false, reason: 'non_public_ipv6_form' };
  }
  const canonical = groups.map((g) => g.toString(16)).join(':');
  if (blockedV6.check(canonical, 'ipv6')) return { ok: false, reason: 'non_public_ipv6' };
  // Only global unicast 2000::/3 is acceptable.
  if ((groups[0]! & 0xe000) !== 0x2000) return { ok: false, reason: 'non_global_ipv6' };
  return { ok: true };
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp', '.test'];

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Validates a URL before any network activity. Uses the WHATWG parser, which
 * canonicalizes odd IPv4 spellings (decimal, hex, short forms) into dotted form.
 */
export function validateFetchUrl(raw: string): UrlVerdict {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: 'invalid_url' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_allowed' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'embedded_credentials' };
  }
  if (url.port !== '') {
    return { ok: false, reason: 'port_not_allowed' };
  }
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return { ok: false, reason: 'invalid_host' };
  if (host.startsWith('[') && host.endsWith(']')) {
    const verdict = classifyAddress(host.slice(1, -1));
    return { ok: false, reason: verdict.ok ? 'ip_literal_not_allowed' : verdict.reason };
  }
  if (net.isIPv4(host)) {
    const verdict = classifyAddress(host);
    return { ok: false, reason: verdict.ok ? 'ip_literal_not_allowed' : verdict.reason };
  }
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'internal_hostname' };
  }
  if (!host.includes('.')) return { ok: false, reason: 'single_label_hostname' };
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: 'invalid_host' };
  return { ok: true, url };
}
