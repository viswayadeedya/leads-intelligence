// Operator authentication: no passwordless path, hashed passphrase, a lockout
// that cannot be reset by the client, session limits, and a host-name check
// that stops another website from reaching the app through DNS rebinding.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as auth from '@/lib/auth';
import { ATTEMPT_WINDOW_MS, authStatus, changePassphrase, completeSetup, lockedUntil, MAX_FAILED_ATTEMPTS, prepareSetup, resolveSession, signIn, signOut, signOutEverywhere } from '@/lib/auth';
import { loadConfig } from '@/lib/config';
import { isAllowedHost, isSameOrigin } from '@/lib/security/origin';
import { hashPassphrase, passphraseProblem, verifyPassphrase } from '@/lib/security/passphrase';
import { MemoryStore } from '@/lib/store';
import { memorySink, NOW, signInForTest, TEST_PASSPHRASE } from './helpers';

const config = loadConfig({});
const NO_ENV = {};
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const WRONG = 'this is not the passphrase';

function freshSetup() {
  const store = new MemoryStore();
  const m = memorySink();
  prepareSetup(store, NO_ENV, NOW, m.sink);
  return { store, m };
}

describe('there is no way in without a credential', () => {
  it('the auth module exports no passwordless or one-click sign-in', () => {
    const names = Object.keys(auth);
    expect(names.filter((n) => /mock|oneclick|one_click|passwordless|bypass|guest|anonymous/i.test(n))).toEqual([]);
    // every function that returns a session token requires a secret argument
    expect(names.filter((n) => typeof (auth as Record<string, unknown>)[n] === 'function').sort()).toEqual(
      ['authStatus', 'changePassphrase', 'completeSetup', 'lockedUntil', 'parseCookieHeader', 'prepareSetup', 'readNotice', 'resolveSession', 'setNotice', 'signIn', 'signOut', 'signOutEverywhere'].sort(),
    );
  });

  it('no application file offers a sign-in action that takes no secret', () => {
    const actions = fs.readFileSync(path.join(process.cwd(), 'src/app/actions.ts'), 'utf8');
    expect(actions).not.toMatch(/signInMock|Continue as local operator|x-forwarded-for/i);
    const login = fs.readFileSync(path.join(process.cwd(), 'src/app/login/page.tsx'), 'utf8');
    expect(login).not.toMatch(/one click|one-click|Continue as local operator/i);
    // both forms on the sign-in page ask for a secret
    expect(login.match(/<form /g)).toHaveLength(2);
    expect(login.match(/type="password"/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('before setup, a passphrase cannot sign in and no token resolves', () => {
    const store = new MemoryStore();
    expect(authStatus(store, NO_ENV, NOW).mode).toBe('setup_required');
    expect(() => signIn(store, config, NO_ENV, NOW, TEST_PASSPHRASE)).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    expect(() => signIn(store, config, NO_ENV, NOW, '')).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('sessions that predate the credential requirement are not honoured', () => {
    const store = new MemoryStore();
    const legacyToken = 'L'.repeat(43);
    store.transact((db) => {
      // what the earlier one-click sign-in stored
      db.sessions.push({ tokenHash: sha(legacyToken), userId: 'usr_local-operator', createdAt: NOW.toISOString(), expiresAt: at(480).toISOString() });
    });
    expect(resolveSession(store, NOW, legacyToken)).toBeNull();
  });
});

function sha(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('first-run setup', () => {
  it('writes a one-time code to the sink, stores only its hash, and is idempotent', () => {
    const { store, m } = freshSetup();
    const code = m.code()!;
    expect(code.length).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(store.snapshot())).not.toContain(code);
    prepareSetup(store, NO_ENV, NOW, m.sink);
    expect(m.code()).toBe(code);
    // if the file was deleted, a new code replaces the old one
    m.sink.remove();
    prepareSetup(store, NO_ENV, NOW, m.sink);
    expect(m.code()).not.toBe(code);
    expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE })).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
  });

  it('a wrong or missing code is refused and counted; the right code with a bad passphrase is refused without burning the code', () => {
    const { store, m } = freshSetup();
    for (const code of ['', 'wrong-code-wrong-code-wrong', m.code()!.slice(0, -1)]) {
      expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE })).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    }
    expect(authStatus(store, NO_ENV, NOW).failedAttempts).toBe(3);
    const code = m.code()!;
    expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: 'short', confirm: 'short' })).toThrowError(expect.objectContaining({ code: 'validation' }));
    expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: TEST_PASSPHRASE, confirm: `${TEST_PASSPHRASE}x` })).toThrowError(expect.objectContaining({ code: 'validation' }));
    expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: code, confirm: code })).toThrowError(expect.objectContaining({ code: 'validation' }));
    expect(authStatus(store, NO_ENV, NOW).failedAttempts).toBe(3);
    expect(store.snapshot().auth.credential).toBeNull();
    // still usable
    const token = completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE });
    expect(resolveSession(store, NOW, token)).toEqual({ userId: 'usr_local-operator', kind: 'human' });
  });

  it('on success: only a scrypt hash is stored, the code is destroyed, and setup cannot be run again', () => {
    const { store, m } = freshSetup();
    const code = m.code()!;
    completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE });
    const db = store.snapshot();
    const dump = JSON.stringify(db);
    expect(dump).not.toContain(TEST_PASSPHRASE);
    expect(dump).not.toContain(code);
    expect(db.auth.credential!.hash).toMatch(/^scrypt\$N=32768,r=8,p=3\$/);
    expect(db.auth.setup).toBeNull();
    expect(m.code()).toBeNull();
    expect(db.auditEvents.map((a) => a.action)).toEqual(expect.arrayContaining(['auth.setup_code_issued', 'auth.passphrase_set', 'auth.signed_in']));
    expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code, passphrase: 'another long passphrase', confirm: 'another long passphrase' })).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    expect(prepareSetup(store, NO_ENV, NOW, m.sink).needed).toBe(false);
    expect(m.code()).toBeNull();
  });

  it('repeated wrong setup codes lock setup, so the code cannot be guessed', () => {
    const { store, m } = freshSetup();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code: `guess-${i}-guess-guess-guess`, passphrase: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE })).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    }
    // even the right code is refused while locked
    expect(() => completeSetup(store, config, NO_ENV, NOW, m.sink, { code: m.code()!, passphrase: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE })).toThrowError(expect.objectContaining({ code: 'rate_limited' }));
    expect(store.snapshot().auth.credential).toBeNull();
  });
});

describe('passphrase rules and storage', () => {
  it.each([
    ['too short', 'elevenchars'],
    ['empty', ''],
    ['mostly spaces', `a${' '.repeat(20)}b`],
    ['one repeated character', 'aaaaaaaaaaaaaaaa'],
    ['few distinct characters', 'abababababababab'],
    ['a famous example phrase', 'correct horse battery staple'],
    ['a famous example phrase, different case', 'Correct Horse Battery Staple'],
    ['a common password that meets the length', 'passwordpassword'],
    ['a keyboard run', '123456789012'],
    ['far too long', 'x1y2'.repeat(60)],
  ])('refuses %s', (_label, candidate) => {
    expect(passphraseProblem(candidate)).not.toBeNull();
  });

  it('accepts ordinary long passphrases and never echoes the passphrase in a message', () => {
    for (const ok of [TEST_PASSPHRASE, 'Tr0ub4dor & three more words', 'größere-straße-nördlich-42']) expect(passphraseProblem(ok)).toBeNull();
    expect(passphraseProblem('hunter2hunt')).not.toContain('hunter2hunt');
  });

  it('hashes with a fresh salt each time and verifies only the right passphrase', () => {
    const a = hashPassphrase(TEST_PASSPHRASE);
    const b = hashPassphrase(TEST_PASSPHRASE);
    expect(a).not.toBe(b);
    expect(a).not.toContain(TEST_PASSPHRASE);
    expect(verifyPassphrase(TEST_PASSPHRASE, a)).toBe(true);
    expect(verifyPassphrase(TEST_PASSPHRASE, b)).toBe(true);
    expect(verifyPassphrase(`${TEST_PASSPHRASE} `, a)).toBe(false);
    expect(verifyPassphrase(TEST_PASSPHRASE.toUpperCase(), a)).toBe(false);
    expect(verifyPassphrase('', a)).toBe(false);
  });

  it('rejects a tampered or malformed stored hash instead of computing it', () => {
    const good = hashPassphrase(TEST_PASSPHRASE);
    const [, , salt, key] = good.split('$');
    const started = Date.now();
    for (const stored of [
      '',
      TEST_PASSPHRASE,
      'plain$whatever',
      `scrypt$N=1,r=8,p=1$${salt}$${key}`, // trivially cheap
      `scrypt$N=1048576,r=8,p=1$${salt}$${key}`, // absurdly expensive
      `scrypt$N=32769,r=8,p=1$${salt}$${key}`, // not a power of two
      `scrypt$N=32768,r=99,p=1$${salt}$${key}`,
      `scrypt$N=32768,r=8,p=0$${salt}$${key}`,
      `scrypt$N=32768,r=8,p=64$${salt}$${key}`, // absurdly expensive
      `scrypt$N=32768,r=8,p=1$${salt}$AAAA`,
      `scrypt$N=32768,r=8,p=1$$${key}`,
      `${good}$extra`,
    ]) {
      expect(verifyPassphrase(TEST_PASSPHRASE, stored), stored.slice(0, 30)).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('sign-in and lockout', () => {
  it('the right passphrase signs in; a wrong one is refused, counted and audited without recording what was typed', () => {
    const store = new MemoryStore();
    signInForTest(store, config, NOW);
    expect(() => signIn(store, config, NO_ENV, at(1), WRONG)).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    const db = store.snapshot();
    expect(db.auditEvents.filter((a) => a.action === 'auth.sign_in_failed')).toHaveLength(1);
    expect(JSON.stringify(db)).not.toContain(WRONG);
    const token = signIn(store, config, NO_ENV, at(2), TEST_PASSPHRASE);
    expect(resolveSession(store, at(2), token)).not.toBeNull();
    // a successful sign-in clears the counter
    expect(authStatus(store, NO_ENV, at(2)).failedAttempts).toBe(0);
  });

  it('locks after 5 failures for everyone: there is no per-client key to rotate, and the correct passphrase is refused while locked', () => {
    const store = new MemoryStore();
    signInForTest(store, config, NOW);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(() => signIn(store, config, NO_ENV, at(i), `${WRONG} ${i}`)).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    }
    // signIn takes no client identifier at all
    expect(signIn.length).toBe(5);
    const during = at(MAX_FAILED_ATTEMPTS);
    expect(lockedUntil(store.snapshot(), during)).not.toBeNull();
    expect(() => signIn(store, config, NO_ENV, during, TEST_PASSPHRASE)).toThrowError(expect.objectContaining({ code: 'rate_limited' }));
    // attempts made while locked do not extend the lock
    for (let i = 0; i < 20; i++) expect(() => signIn(store, config, NO_ENV, during, WRONG)).toThrowError(expect.objectContaining({ code: 'rate_limited' }));
    expect(store.snapshot().loginAttempts).toHaveLength(MAX_FAILED_ATTEMPTS);
    expect(store.snapshot().auditEvents.filter((a) => a.action === 'auth.locked_out')).toHaveLength(1);
    // it ends on its own
    const after = new Date(NOW.getTime() + ATTEMPT_WINDOW_MS + 60_000);
    expect(lockedUntil(store.snapshot(), after)).toBeNull();
    expect(resolveSession(store, after, signIn(store, config, NO_ENV, after, TEST_PASSPHRASE))).not.toBeNull();
  });

  it('an existing session keeps working during a lockout (the operator is not thrown out by someone guessing)', () => {
    const store = new MemoryStore();
    const token = signInForTest(store, config, NOW);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) expect(() => signIn(store, config, NO_ENV, at(1), WRONG)).toThrow();
    expect(resolveSession(store, at(2), token)).not.toBeNull();
  });

  it('OPERATOR_PASSPHRASE: a strong one is required when set; a weak one is never accepted', () => {
    const store = new MemoryStore();
    signInForTest(store, config, NOW);
    const strongEnv = { OPERATOR_PASSPHRASE: 'granite teapot orbit lantern' };
    expect(authStatus(store, strongEnv, NOW).mode).toBe('env_passphrase');
    expect(resolveSession(store, NOW, signIn(store, config, strongEnv, NOW, 'granite teapot orbit lantern'))).not.toBeNull();
    // the stored passphrase does not work while the environment one is set
    expect(() => signIn(store, config, strongEnv, NOW, TEST_PASSPHRASE)).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    const weakEnv = { OPERATOR_PASSPHRASE: 'hunter2' };
    expect(authStatus(store, weakEnv, NOW).envPassphraseProblem).not.toBeNull();
    expect(() => signIn(store, config, weakEnv, NOW, 'hunter2')).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    // setup cannot be used to get around a configured passphrase
    const m = memorySink();
    expect(prepareSetup(new MemoryStore(), strongEnv, NOW, m.sink).needed).toBe(false);
    expect(m.code()).toBeNull();
  });
});

describe('sessions', () => {
  it('end after inactivity, and after the absolute limit even when active', () => {
    const store = new MemoryStore();
    const idle = signInForTest(store, config, NOW);
    expect(resolveSession(store, at(config.sessionIdleMinutes - 1), idle)).not.toBeNull();
    // that request counted as activity, so the idle clock restarted
    expect(resolveSession(store, at(config.sessionIdleMinutes + 30), idle)).not.toBeNull();
    expect(resolveSession(store, at(config.sessionIdleMinutes * 2 + 31), idle)).toBeNull();

    const busyStore = new MemoryStore();
    const busy = signInForTest(busyStore, config, NOW);
    for (let m = 30; m < config.sessionTtlMinutes; m += 30) expect(resolveSession(busyStore, at(m), busy), `minute ${m}`).not.toBeNull();
    expect(resolveSession(busyStore, at(config.sessionTtlMinutes + 1), busy)).toBeNull();
  });

  it('sign-out ends one session; "sign out everywhere" ends the rest; the number of sessions is capped', () => {
    const store = new MemoryStore();
    const first = signInForTest(store, config, NOW);
    const tokens = [first];
    for (let i = 1; i <= config.maxSessions + 2; i++) tokens.push(signIn(store, config, NO_ENV, at(i), TEST_PASSPHRASE));
    const last = at(config.maxSessions + 3);
    expect(store.snapshot().sessions).toHaveLength(config.maxSessions);
    // the oldest were dropped
    expect(resolveSession(store, last, first)).toBeNull();
    const newest = tokens.at(-1)!;
    const other = tokens.at(-2)!;
    signOut(store, other);
    expect(resolveSession(store, last, other)).toBeNull();
    expect(resolveSession(store, last, newest)).not.toBeNull();
    const ended = signOutEverywhere(store, last, newest);
    expect(ended).toBe(config.maxSessions - 2);
    expect(store.snapshot().sessions).toHaveLength(1);
    expect(resolveSession(store, last, newest)).not.toBeNull();
  });

  it('changing the passphrase needs the current one, ends other sessions, and the old passphrase stops working', () => {
    const store = new MemoryStore();
    const mine = signInForTest(store, config, NOW);
    const other = signIn(store, config, NO_ENV, at(1), TEST_PASSPHRASE);
    const next = 'walnut harbor thirteen clocks';
    expect(() => changePassphrase(store, NO_ENV, at(2), { current: WRONG, next, confirm: next, keepToken: mine })).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    expect(() => changePassphrase(store, NO_ENV, at(2), { current: TEST_PASSPHRASE, next: 'short', confirm: 'short', keepToken: mine })).toThrowError(expect.objectContaining({ code: 'validation' }));
    expect(() => changePassphrase(store, NO_ENV, at(2), { current: TEST_PASSPHRASE, next, confirm: `${next}!`, keepToken: mine })).toThrowError(expect.objectContaining({ code: 'validation' }));
    expect(() => changePassphrase(store, NO_ENV, at(2), { current: TEST_PASSPHRASE, next: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE, keepToken: mine })).toThrowError(expect.objectContaining({ code: 'validation' }));
    changePassphrase(store, NO_ENV, at(3), { current: TEST_PASSPHRASE, next, confirm: next, keepToken: mine });
    expect(resolveSession(store, at(3), mine)).not.toBeNull();
    expect(resolveSession(store, at(3), other)).toBeNull();
    expect(() => signIn(store, config, NO_ENV, at(4), TEST_PASSPHRASE)).toThrowError(expect.objectContaining({ code: 'unauthenticated' }));
    expect(resolveSession(store, at(5), signIn(store, config, NO_ENV, at(5), next))).not.toBeNull();
    const dump = JSON.stringify(store.snapshot());
    expect(dump).not.toContain(next);
    expect(dump).not.toContain(TEST_PASSPHRASE);
  });
});

describe('host-name check (DNS rebinding against the app itself)', () => {
  const allowed = config.allowedHosts;
  it.each(['localhost', 'localhost:3210', '127.0.0.1', '127.0.0.1:3210', '[::1]', '[::1]:3210', 'LOCALHOST:3210'])('answers to %s', (host) => {
    expect(isAllowedHost(host, allowed)).toBe(true);
  });

  it.each([
    'attacker.example:3210',
    'rebind.attacker.example',
    '127.0.0.1.attacker.example:3210',
    'localhost.attacker.example',
    'attacker.example#localhost',
    'localhost@attacker.example',
    'attacker.example/localhost',
    'localhost:3210:80',
    'localhost:abc',
    '0.0.0.0:3210',
    '192.168.1.20:3210',
    '[::1',
    '[::1]evil',
    '[fe80::1]:3210',
    'local host',
    ' ',
    '',
  ])('refuses %j', (host) => {
    expect(isAllowedHost(host, allowed)).toBe(false);
  });

  it('refuses a missing Host header, and only adds extra names that are explicitly configured', () => {
    expect(isAllowedHost(null, allowed)).toBe(false);
    const extra = loadConfig({ OI_ALLOWED_HOSTS: 'research.internal.example, bad host!, https://x.example' }).allowedHosts;
    expect(extra).toEqual(['localhost', '127.0.0.1', '[::1]', 'research.internal.example']);
    expect(isAllowedHost('research.internal.example:3210', extra)).toBe(true);
    expect(isAllowedHost('other.internal.example', extra)).toBe(false);
  });

  it('a rebinding page passes the same-origin check (its Origin equals its Host), which is why the host check exists', () => {
    expect(isSameOrigin('http://attacker.example:3210', 'attacker.example:3210')).toBe(true);
    expect(isAllowedHost('attacker.example:3210', allowed)).toBe(false);
  });

  it('the request proxy applies the host check before anything else', () => {
    const proxy = fs.readFileSync(path.join(process.cwd(), 'src/proxy.ts'), 'utf8');
    const hostCheck = proxy.indexOf('isAllowedHost(');
    expect(hostCheck).toBeGreaterThan(0);
    expect(hostCheck).toBeLessThan(proxy.indexOf('isStateChanging('));
    expect(hostCheck).toBeLessThan(proxy.indexOf('request.cookies.has('));
  });
});
