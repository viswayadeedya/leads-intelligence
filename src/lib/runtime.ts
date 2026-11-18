// Server-only wiring: builds the request context from the session cookie.
// Authorization is enforced here, server-side, on every page, action and API call.

import fs from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { parseCookieHeader, resolveSession, SESSION_COOKIE, type SetupSink } from './auth';
import { loadConfig, type AppConfig } from './config';
import type { Ctx } from './context';
import { AppError } from './errors';
import { MockRuleReasoner } from './reasoning/reasoner';
import { MockFixtureTransport } from './sources/mock-transport';
import { JsonFileStore, type Store } from './store';
import type { Actor } from './types';

export function getConfig(): AppConfig {
  return loadConfig();
}

export function getStore(): Store {
  return new JsonFileStore(getConfig().dataDir);
}

/**
 * The one-time setup code goes into a file in the data folder, readable only
 * by someone who can already read this machine's files. It is never logged,
 * never sent to the browser, and deleted as soon as setup completes.
 */
export function getSetupSink(): SetupSink {
  const dir = path.resolve(getConfig().dataDir);
  const file = path.join(dir, 'setup-code.txt');
  return {
    location: path.join(getConfig().dataDir, 'setup-code.txt'),
    exists: () => fs.existsSync(file),
    write: (code) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${code}\n\nOne-time setup code for the Opportunity Intelligence sign-in page.\nPaste the first line into the "Setup code" box. This file is deleted once setup is done.\n`, { encoding: 'utf8', mode: 0o600 });
    },
    remove: () => fs.rmSync(file, { force: true }),
  };
}

function buildCtx(actor: Actor): Ctx {
  const config = getConfig();
  return {
    store: new JsonFileStore(config.dataDir),
    config,
    actor,
    now: () => new Date(),
    // This build is mock-only: the live transport is never constructed here.
    transport: new MockFixtureTransport(),
    reasoner: new MockRuleReasoner(),
  };
}

export async function getOptionalActor(): Promise<Actor | null> {
  const jar = await cookies();
  return resolveSession(getStore(), new Date(), jar.get(SESSION_COOKIE)?.value);
}

/** For pages and server actions: redirects to /login when there is no valid session. */
export async function requireCtx(): Promise<Ctx> {
  const actor = await getOptionalActor();
  if (!actor) redirect('/login');
  return buildCtx(actor);
}

/** For API route handlers: throws 401 instead of redirecting. */
export function ctxFromRequest(request: Request): Ctx {
  const token = parseCookieHeader(request.headers.get('cookie'), SESSION_COOKIE);
  const actor = resolveSession(getStore(), new Date(), token);
  if (!actor) throw new AppError('unauthenticated', 'Sign in first.');
  return buildCtx(actor);
}
