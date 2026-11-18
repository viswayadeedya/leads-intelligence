// Single-operator authentication.
//
// There is no way to get a session without proving something:
//
//   first run   a one-time setup code that the server writes to a file in the
//               data folder (so only someone with access to this machine's
//               files can read it), plus a passphrase the operator chooses.
//   afterwards  that passphrase. Only a salted scrypt hash of it is stored.
//
// Failed attempts are counted globally, not per client, so they cannot be
// reset by changing a header. Sessions are random tokens stored as SHA-256
// hashes; they expire on an absolute limit and on inactivity, and sign-out
// really invalidates them. The cookie is HttpOnly + SameSite=Strict.
//
// Not provided: a second factor. See docs/delivery/DECISIONS.md.

import type { AppConfig } from './config';
import { AppError } from './errors';
import { newId, randomToken, sha256 } from './ids';
import { hashPassphrase, passphraseProblem, secretsEqual, verifyPassphrase } from './security/passphrase';
import type { Store } from './store';
import type { Actor, Db, Notice } from './types';

export const SESSION_COOKIE = 'oi_session';
export const LOCAL_OPERATOR_ID = 'usr_local-operator';
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60_000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/** Where the one-time setup code is put for the operator to read. The app uses a file; tests use memory. */
export type SetupSink = {
  /** shown to the operator so they know where to look; never the code itself */
  readonly location: string;
  exists(): boolean;
  write(code: string): void;
  remove(): void;
};

export type AuthMode = 'setup_required' | 'stored_passphrase' | 'env_passphrase';
export type AuthStatus = {
  mode: AuthMode;
  /** OPERATOR_PASSPHRASE is set but too weak to be accepted */
  envPassphraseProblem: string | null;
  lockedUntil: string | null;
  failedAttempts: number;
  activeSessions: number;
  credentialSetAt: string | null;
};

function audit(db: Db, now: Date, action: string, detail: string, actorKind: 'human' | 'system'): void {
  db.auditEvents.push({ id: newId('aud'), ownerId: LOCAL_OPERATOR_ID, actorKind, action, targetType: 'user', targetId: LOCAL_OPERATOR_ID, detail, at: now.toISOString() });
}

function recentFailures(db: Db, now: Date): number[] {
  const cutoff = now.getTime() - ATTEMPT_WINDOW_MS;
  return db.loginAttempts.map((a) => new Date(a.at).getTime()).filter((t) => t > cutoff && t <= now.getTime()).sort((a, b) => a - b);
}

/** Non-null while sign-in and setup are locked. Counted across all clients on purpose. */
export function lockedUntil(db: Db, now: Date): Date | null {
  const failures = recentFailures(db, now);
  if (failures.length < MAX_FAILED_ATTEMPTS) return null;
  // Unlocks when the oldest of the last MAX failures leaves the window.
  return new Date(failures[failures.length - MAX_FAILED_ATTEMPTS]! + ATTEMPT_WINDOW_MS);
}

function assertNotLocked(db: Db, now: Date): void {
  const until = lockedUntil(db, now);
  if (until) {
    const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
    throw new AppError('rate_limited', `Too many failed attempts. Sign-in is locked for about ${minutes} more minute(s).`);
  }
}

function recordFailure(store: Store, now: Date, what: string): void {
  store.transact((db) => {
    const cutoff = now.getTime() - ATTEMPT_WINDOW_MS;
    db.loginAttempts = db.loginAttempts.filter((a) => new Date(a.at).getTime() > cutoff);
    db.loginAttempts.push({ key: 'all', at: now.toISOString() });
    audit(db, now, 'auth.sign_in_failed', `${what} was not accepted.`, 'system');
    if (recentFailures(db, now).length === MAX_FAILED_ATTEMPTS) {
      audit(db, now, 'auth.locked_out', `Sign-in locked after ${MAX_FAILED_ATTEMPTS} failed attempts within 15 minutes.`, 'system');
    }
  });
}

function envPassphrase(env: Record<string, string | undefined>): string | null {
  const value = env.OPERATOR_PASSPHRASE;
  return value && value.length > 0 ? value : null;
}

export function authStatus(store: Store, env: Record<string, string | undefined>, now: Date): AuthStatus {
  const db = store.snapshot();
  const fromEnv = envPassphrase(env);
  const mode: AuthMode = fromEnv ? 'env_passphrase' : db.auth.credential ? 'stored_passphrase' : 'setup_required';
  return {
    mode,
    envPassphraseProblem: fromEnv ? passphraseProblem(fromEnv) : null,
    lockedUntil: lockedUntil(db, now)?.toISOString() ?? null,
    failedAttempts: recentFailures(db, now).length,
    activeSessions: db.sessions.filter((s) => sessionIsLive(s, now)).length,
    credentialSetAt: db.auth.credential?.updatedAt ?? null,
  };
}

function sessionIsLive(s: Db['sessions'][number], now: Date): boolean {
  // Sessions created before sign-in required a credential have no idle limit recorded. They are not honoured.
  if (typeof s.idleMinutes !== 'number' || typeof s.lastSeenAt !== 'string') return false;
  const t = now.getTime();
  if (new Date(s.expiresAt).getTime() <= t) return false;
  if (new Date(s.lastSeenAt).getTime() + s.idleMinutes * 60_000 <= t) return false;
  return true;
}

function createSession(db: Db, config: AppConfig, now: Date): string {
  const token = randomToken();
  if (!db.users.some((u) => u.id === LOCAL_OPERATOR_ID)) {
    db.users.push({ id: LOCAL_OPERATOR_ID, label: 'Local operator', createdAt: now.toISOString(), notice: null });
  }
  db.sessions = db.sessions.filter((s) => sessionIsLive(s, now));
  // Bounded: the oldest sessions go first.
  db.sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (db.sessions.length >= config.maxSessions) db.sessions.shift();
  db.sessions.push({
    tokenHash: sha256(token),
    userId: LOCAL_OPERATOR_ID,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.sessionTtlMinutes * 60_000).toISOString(),
    lastSeenAt: now.toISOString(),
    idleMinutes: config.sessionIdleMinutes,
  });
  db.loginAttempts = [];
  audit(db, now, 'auth.signed_in', 'Signed in.', 'human');
  return token;
}

/**
 * First run only. Makes sure a one-time setup code exists and is readable in
 * the sink. Returns where to find it. Does nothing once a credential exists.
 */
export function prepareSetup(store: Store, env: Record<string, string | undefined>, now: Date, sink: SetupSink): { needed: boolean; location: string } {
  const db = store.snapshot();
  if (db.auth.credential || envPassphrase(env)) return { needed: false, location: sink.location };
  if (db.auth.setup && sink.exists()) return { needed: true, location: sink.location };
  const code = randomToken(18);
  store.transact((d) => {
    d.auth.setup = { codeHash: sha256(code), createdAt: now.toISOString() };
    audit(d, now, 'auth.setup_code_issued', 'A one-time setup code was written to the data folder.', 'system');
  });
  sink.write(code);
  return { needed: true, location: sink.location };
}

/** First run: setup code + a new passphrase. On success the code is destroyed and a session starts. */
export function completeSetup(
  store: Store,
  config: AppConfig,
  env: Record<string, string | undefined>,
  now: Date,
  sink: SetupSink,
  input: { code: string; passphrase: string; confirm: string },
): string {
  const before = store.snapshot();
  if (before.auth.credential || envPassphrase(env)) throw new AppError('forbidden', 'Sign-in is already set up. Use the passphrase.');
  assertNotLocked(before, now);
  const setup = before.auth.setup;
  const suppliedHash = sha256(typeof input.code === 'string' ? input.code.trim() : '');
  if (!setup || !secretsEqual(suppliedHash, setup.codeHash)) {
    recordFailure(store, now, 'A setup code');
    throw new AppError('unauthenticated', 'That setup code was not accepted. Copy it again from the file.');
  }
  // A weak or mistyped passphrase does not consume the code or count as a failed attempt.
  if (input.passphrase !== input.confirm) throw new AppError('validation', 'The two passphrases do not match.');
  const problem = passphraseProblem(input.passphrase);
  if (problem) throw new AppError('validation', problem);
  if (input.passphrase.trim() === input.code.trim()) throw new AppError('validation', 'Do not reuse the setup code as your passphrase.');

  const hash = hashPassphrase(input.passphrase);
  const token = store.transact((db) => {
    if (db.auth.credential) throw new AppError('forbidden', 'Sign-in is already set up. Use the passphrase.');
    db.auth.credential = { hash, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.auth.setup = null;
    db.sessions = [];
    audit(db, now, 'auth.passphrase_set', 'Operator passphrase created. The setup code was destroyed.', 'human');
    return createSession(db, config, now);
  });
  sink.remove();
  return token;
}

function checkPassphrase(db: Db, env: Record<string, string | undefined>, supplied: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0 || supplied.length > 200) return false;
  const fromEnv = envPassphrase(env);
  if (fromEnv) {
    // A weak configured passphrase is never accepted, so it cannot quietly become the only protection.
    if (passphraseProblem(fromEnv)) return false;
    return secretsEqual(supplied, fromEnv);
  }
  if (!db.auth.credential) return false;
  return verifyPassphrase(supplied, db.auth.credential.hash);
}

export function signIn(store: Store, config: AppConfig, env: Record<string, string | undefined>, now: Date, supplied: string): string {
  const db = store.snapshot();
  const fromEnv = envPassphrase(env);
  if (!fromEnv && !db.auth.credential) throw new AppError('forbidden', 'Sign-in has not been set up yet.');
  if (fromEnv && passphraseProblem(fromEnv)) {
    throw new AppError('forbidden', 'OPERATOR_PASSPHRASE is set but is too weak to be accepted. Remove it to use the stored passphrase, or set a stronger one.');
  }
  // While locked, nothing is evaluated: a correct guess during the lock is refused too.
  assertNotLocked(db, now);
  if (!checkPassphrase(db, env, supplied)) {
    recordFailure(store, now, 'A passphrase');
    throw new AppError('unauthenticated', 'That passphrase was not accepted.');
  }
  return store.transact((d) => createSession(d, config, now));
}

/** Server-side check on every request. Returns null for missing, unknown, expired or idle sessions. */
export function resolveSession(store: Store, now: Date, token: string | undefined | null): Actor | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = sha256(token);
  const session = store.snapshot().sessions.find((s) => s.tokenHash === tokenHash);
  if (!session || !sessionIsLive(session, now)) return null;
  if (now.getTime() - new Date(session.lastSeenAt!).getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
    store.transact((db) => {
      const row = db.sessions.find((s) => s.tokenHash === tokenHash);
      if (row) row.lastSeenAt = now.toISOString();
    });
  }
  return { userId: session.userId, kind: 'human' };
}

export function signOut(store: Store, token: string | undefined | null): void {
  if (!token) return;
  const tokenHash = sha256(token);
  store.transact((db) => {
    db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
  });
}

/** Ends every session, optionally keeping the caller's. */
export function signOutEverywhere(store: Store, now: Date, keepToken?: string | null): number {
  const keep = keepToken ? sha256(keepToken) : null;
  return store.transact((db) => {
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((s) => s.tokenHash === keep);
    const ended = before - db.sessions.length;
    audit(db, now, 'auth.sessions_ended', `${ended} other session(s) ended.`, 'human');
    return ended;
  });
}

/** Requires the current passphrase. Every other session is ended. */
export function changePassphrase(
  store: Store,
  env: Record<string, string | undefined>,
  now: Date,
  input: { current: string; next: string; confirm: string; keepToken?: string | null },
): void {
  if (envPassphrase(env)) throw new AppError('conflict', 'The passphrase comes from OPERATOR_PASSPHRASE. Change it there and restart, or remove it to use a stored passphrase.');
  const db = store.snapshot();
  if (!db.auth.credential) throw new AppError('conflict', 'No stored passphrase exists yet.');
  assertNotLocked(db, now);
  if (!verifyPassphrase(input.current, db.auth.credential.hash)) {
    recordFailure(store, now, 'A current passphrase (while changing it)');
    throw new AppError('unauthenticated', 'The current passphrase was not accepted. Nothing was changed.');
  }
  if (input.next !== input.confirm) throw new AppError('validation', 'The two new passphrases do not match.');
  const problem = passphraseProblem(input.next);
  if (problem) throw new AppError('validation', problem);
  if (input.next === input.current) throw new AppError('validation', 'The new passphrase is the same as the current one.');
  const hash = hashPassphrase(input.next);
  const keep = input.keepToken ? sha256(input.keepToken) : null;
  store.transact((d) => {
    d.auth.credential = { hash, createdAt: d.auth.credential?.createdAt ?? now.toISOString(), updatedAt: now.toISOString() };
    d.sessions = d.sessions.filter((s) => s.tokenHash === keep);
    audit(d, now, 'auth.passphrase_changed', 'Operator passphrase changed. Other sessions were ended.', 'human');
  });
}

export function parseCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
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
