// Server-only wiring: builds the request context from the session cookie.
// Authorization is enforced here, server-side, on every page, action and API call.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { parseCookieHeader, resolveSession, SESSION_COOKIE } from './auth';
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
