// Single-operator authentication.
//
// Sessions are random tokens stored server-side as SHA-256 hashes, so sign-out
// really invalidates them. The cookie is HttpOnly + SameSite=Strict.
//
// Mock mode without OPERATOR_PASSPHRASE allows a one-click local sign-in: the
// only data reachable is synthetic fixtures and whatever the operator types in.
// If OPERATOR_PASSPHRASE is set it is always required.

import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config';
import { AppError } from './errors';
import { newId, randomToken, sha256 } from './ids';
import type { Store } from './store';
import type { Actor, Notice } from './types';

export const SESSION_COOKIE = 'oi_session';
export const LOCAL_OPERATOR_ID = 'usr_local-operator';
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

function createSession(store: Store, config: AppConfig, now: Date, userId: string, label: string): string {
  const token = randomToken();
  store.transact((db) => {
    if (!db.users.some((u) => u.id === userId)) {
      db.users.push({ id: userId, label, createdAt: now.toISOString(), notice: null });
    }
    db.sessions = db.sessions.filter((s) => new Date(s.expiresAt).getTime() > now.getTime());
    db.sessions.push({
      tokenHash: sha256(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.sessionTtlMinutes * 60_000).toISOString(),
    });
    db.auditEvents.push({ id: newId('aud'), ownerId: userId, actorKind: 'human', action: 'auth.signed_in', targetType: 'user', targetId: userId, detail: 'Signed in.', at: now.toISOString() });
  });
  return token;
}

export function signInMock(store: Store, config: AppConfig, now: Date): string {
  if (config.operatorPassphraseSet) {
    throw new AppError('forbidden', 'A passphrase is configured, so one-click sign-in is turned off.');
  }
  return createSession(store, config, now, LOCAL_OPERATOR_ID, 'Local operator');
}

export function signInWithPassphrase(store: Store, config: AppConfig, now: Date, supplied: string, expected: string | undefined, clientKey: string): string {
  if (!expected) throw new AppError('forbidden', 'No passphrase is configured.');
  const key = sha256(clientKey).slice(0, 16);
  const recent = store.snapshot().loginAttempts.filter((a) => a.key === key && new Date(a.at).getTime() > now.getTime() - ATTEMPT_WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    throw new AppError('rate_limited', 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
  const ok = timingSafeEqual(Buffer.from(sha256(supplied), 'hex'), Buffer.from(sha256(expected), 'hex'));
  if (!ok) {
    store.transact((db) => {
      db.loginAttempts = db.loginAttempts.filter((a) => new Date(a.at).getTime() > now.getTime() - ATTEMPT_WINDOW_MS);
      db.loginAttempts.push({ key, at: now.toISOString() });
    });
    throw new AppError('unauthenticated', 'That passphrase was not accepted.');
  }
  return createSession(store, config, now, LOCAL_OPERATOR_ID, 'Local operator');
}

/** Server-side check on every request. Returns null for missing, unknown or expired sessions. */
export function resolveSession(store: Store, now: Date, token: string | undefined | null): Actor | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = sha256(token);
  const session = store.snapshot().sessions.find((s) => s.tokenHash === tokenHash);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= now.getTime()) return null;
  return { userId: session.userId, kind: 'human' };
}

export function signOut(store: Store, token: string | undefined | null): void {
  if (!token) return;
  const tokenHash = sha256(token);
  store.transact((db) => {
    db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
  });
}

export function parseCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function setNotice(store: Store, userId: string, kind: Notice['kind'], text: string): string {
  const id = randomToken(9);
  store.transact((db) => {
    const user = db.users.find((u) => u.id === userId);
    if (user) user.notice = { id, kind, text: text.slice(0, 600) };
  });
  return id;
}

export function readNotice(store: Store, userId: string, id: string | undefined): Notice | null {
  if (!id) return null;
  const user = store.snapshot().users.find((u) => u.id === userId);
  return user?.notice && user.notice.id === id ? user.notice : null;
}
