import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type IdPrefix = 'usr' | 'biz' | 'run' | 'src' | 'ev' | 'opp' | 'rep' | 'out' | 'apr' | 'aud' | 'rej' | 'unk';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

/** Short form for display; the full ID is always available in the source details. */
export function shortId(id: string): string {
  const [prefix, rest] = id.split('_');
  if (!rest) return id;
  return `${prefix}_${rest.slice(0, 8)}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
