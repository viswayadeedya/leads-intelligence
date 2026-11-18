// Operator passphrase handling.
//
// The passphrase is never stored. What is stored is a salted scrypt hash, so
// reading the data file does not reveal it and guessing it offline is slow.
// Comparison is constant-time.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt cost: N=2^15, r=8, p=3. About 32 MB of memory and roughly a tenth of a
// second per guess on a current laptop.
const N = 32_768;
const R = 8;
const P = 3;
const KEY_LENGTH = 32;
const MAX_MEMORY = 96 * 1024 * 1024;

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 200;

// A short list of phrases that meet the length rule but are in every guessing list.
const COMMON = new Set([
  'passwordpassword',
  'password1234',
  'password12345',
  'password123456',
  '123456789012',
  '1234567890123',
  'qwertyuiopas',
  'qwertyuiop123',
  'letmeinletmein',
  'adminadminadmin',
  'administrator1',
  'changemechangeme',
  'iloveyouiloveyou',
  'correct horse battery staple',
  'correcthorsebatterystaple',
  'opportunity intelligence',
  'opportunityintelligence',
  'operatorpassphrase',
  'operator passphrase',
]);

/** Returns why a passphrase is not acceptable, or null. The passphrase itself never appears in the message. */
export function passphraseProblem(passphrase: string): string | null {
  if (typeof passphrase !== 'string') return 'Enter a passphrase.';
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. Several unrelated words work well.`;
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) return `Use at most ${MAX_PASSPHRASE_LENGTH} characters.`;
  if (passphrase.trim().length < MIN_PASSPHRASE_LENGTH) return 'A passphrase cannot be mostly spaces.';
  if (new Set(passphrase).size < 6) return 'Use more variety: this repeats the same few characters.';
  if (COMMON.has(passphrase.toLowerCase().trim())) return 'That passphrase is on every list of common guesses. Choose another.';
  return null;
}

export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Checks a passphrase against a stored hash. A stored value that is malformed,
 * or that asks for more work than this module would ever have produced, is
 * rejected rather than computed, so a tampered data file cannot be used to
 * stall or crash sign-in.
 */
export function verifyPassphrase(passphrase: string, stored: string): boolean {
  if (typeof passphrase !== 'string' || typeof stored !== 'string') return false;
  if (passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) return false;
  const match = /^scrypt\$N=(\d{1,7}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/=]{8,64})\$([A-Za-z0-9+/=]{16,128})$/.exec(stored);
  if (!match) return false;
  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (n < 16_384 || n > 131_072 || (n & (n - 1)) !== 0 || r !== 8 || p < 1 || p > 4) return false;
  const salt = Buffer.from(match[4]!, 'base64');
  const expected = Buffer.from(match[5]!, 'base64');
  if (salt.length < 8 || expected.length !== KEY_LENGTH) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(passphrase.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

const PROCESS_SALT = randomBytes(16);

/** Constant-time comparison of two secrets of any length, without revealing either length. */
export function secretsEqual(a: string, b: string): boolean {
  const ka = scryptSync(a.normalize('NFKC'), PROCESS_SALT, KEY_LENGTH, { N: 16_384, r: R, p: 1, maxmem: MAX_MEMORY });
  const kb = scryptSync(b.normalize('NFKC'), PROCESS_SALT, KEY_LENGTH, { N: 16_384, r: R, p: 1, maxmem: MAX_MEMORY });
  return timingSafeEqual(ka, kb);
}
