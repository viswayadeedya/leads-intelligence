// Identity normalization and checks (PAIN_FIRST step 1, playbook Stage A).
// The goal is to avoid attributing a source to the wrong company.

import net from 'node:net';
import { AppError } from './errors';
import type { Business } from './types';

const SUFFIXES = new Set(['llc', 'inc', 'co', 'corp', 'company', 'ltd', 'synthetic']);

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !SUFFIXES.has(w))
    .join(' ')
    .trim();
}

/** Accepts "example.com", "www.example.com/path" or a full http(s) URL. Returns a bare host or throws. */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 300) {
    throw new AppError('validation', 'Enter a website like example.com.');
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError('validation', 'That website address could not be read. Enter something like example.com.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('validation', 'Only http and https websites can be investigated.');
  }
  if (url.username || url.password) {
    throw new AppError('validation', 'Website addresses must not contain a username or password.');
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (net.isIP(host) || host.startsWith('[') || host === 'localhost' || !host.includes('.')) {
    throw new AppError('validation', 'Enter a public website domain, not an IP address or internal host.');
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new AppError('validation', 'That website address contains unsupported characters.');
  }
  return host;
}

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D+/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export type DuplicateFinding = { otherId: string; reason: string };

/**
 * Flags likely duplicates for operator review. Never merges silently.
 * A same-name business in a different city is NOT a duplicate; it is an
 * identity risk that the identity stage checks against the website itself.
 */
export function findPossibleDuplicate(
  candidate: Pick<Business, 'normalizedName' | 'domain' | 'phone' | 'city' | 'state'>,
  existing: Business[],
): DuplicateFinding | null {
  for (const other of existing) {
    if (other.duplicateResolution === 'marked_duplicate') continue;
    if (candidate.domain && other.domain && candidate.domain === other.domain) {
      return { otherId: other.id, reason: 'same website domain' };
    }
    const samePlace =
      candidate.city.toLowerCase() === other.city.toLowerCase() &&
      candidate.state.toLowerCase() === other.state.toLowerCase();
    if (
      candidate.phone &&
      other.phone &&
      normalizePhone(candidate.phone).length >= 10 &&
      normalizePhone(candidate.phone) === normalizePhone(other.phone)
    ) {
      return { otherId: other.id, reason: 'same phone number' };
    }
    if (samePlace && candidate.normalizedName === other.normalizedName) {
      return { otherId: other.id, reason: 'same name and city' };
    }
  }
  return null;
}

export type IdentityCheck = {
  status: 'confirmed' | 'ambiguous' | 'unverified';
  reasons: string[];
};

const GENERIC_WORDS = new Set([
  'heating', 'cooling', 'hvac', 'air', 'and', 'the', 'services', 'service', 'conditioning', 'climate', 'comfort', 'of',
]);

const PARENT_PATTERNS = [
  /\ba (?:division|subsidiary|brand|member) of ([A-Z][\w&' -]{2,60})/,
  /\bpart of the ([A-Z][\w&' -]{2,60}) (?:family|group|network)/,
  /\bindependently owned and operated franchise\b/i,
  /\ban? ([A-Z][\w&' -]{2,60}) company\b/,
];

/** "City, ST" mentions found in page text. */
export function extractStatedLocations(text: string): { city: string; state: string }[] {
  const out: { city: string; state: string }[] = [];
  const re = /\b([A-Z][a-zA-Z.]+(?: [A-Z][a-zA-Z.]+){0,2}),\s*([A-Z]{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 50) {
    out.push({ city: m[1]!.trim(), state: m[2]! });
  }
  return out;
}

/**
 * Compares the business record with what its own website states.
 * Conservative: anything short of a clear name + location match needs the operator.
 */
export function checkIdentityAgainstSite(
  business: Pick<Business, 'displayName' | 'normalizedName' | 'city' | 'state' | 'phone'>,
  site: { title: string; text: string; phones: string[] },
): IdentityCheck {
  const reasons: string[] = [];
  const haystack = normalizeName(`${site.title} ${site.text}`);
  const tokens = business.normalizedName.split(' ').filter((t) => t && !GENERIC_WORDS.has(t));
  const nameTokens = tokens.length > 0 ? tokens : business.normalizedName.split(' ').filter(Boolean);
  const nameMatches = nameTokens.length > 0 && nameTokens.every((t) => haystack.includes(t));
  if (!nameMatches) reasons.push('The business name was not found on the home page.');

  const stated = extractStatedLocations(site.text);
  // endsWith: the pattern can pick up a leading capitalized word ("Serving Lansing, MI").
  const wantCity = business.city.toLowerCase();
  const cityMatch = stated.some((l) => {
    const got = l.city.toLowerCase();
    return (got === wantCity || got.endsWith(` ${wantCity}`)) && l.state.toLowerCase() === business.state.toLowerCase();
  });
  let locationMismatch = false;
  if (!cityMatch && stated.length > 0) {
    locationMismatch = true;
    const seen = [...new Set(stated.map((l) => `${l.city}, ${l.state}`))].slice(0, 3).join('; ');
    reasons.push(`The home page states ${seen}, not ${business.city}, ${business.state}. This may be a different company with the same name.`);
  } else if (!cityMatch) {
    reasons.push(`The home page does not state a location, so ${business.city}, ${business.state} could not be confirmed.`);
  }

  let parent = false;
  for (const re of PARENT_PATTERNS) {
    if (re.test(site.text)) {
      parent = true;
      reasons.push('The home page describes a parent company, franchise or group. Confirm which legal entity you mean.');
      break;
    }
  }

  if (business.phone) {
    const want = normalizePhone(business.phone);
    const phoneMatch = site.phones.some((p) => normalizePhone(p) === want);
    if (!phoneMatch && site.phones.length > 0) {
      reasons.push('The phone number on record does not match any number on the home page.');
    }
  }

  if (locationMismatch || parent || !nameMatches) return { status: 'ambiguous', reasons };
  if (!cityMatch) return { status: 'unverified', reasons };
  return { status: 'confirmed', reasons: [] };
}
