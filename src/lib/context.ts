import type { AppConfig } from './config';
import type { Store } from './store';
import type { Actor, AuditEvent, Db } from './types';
import { AppError } from './errors';
import { newId } from './ids';
import type { PageTransport } from './sources/transport';
import type { Reasoner } from './reasoning/reasoner';

/** Everything a service call needs. The actor is established server-side per request. */
export type Ctx = {
  store: Store;
  config: AppConfig;
  actor: Actor;
  now: () => Date;
  transport: PageTransport;
  reasoner: Reasoner;
};

type Owned = { id: string; ownerId: string };

/**
 * Owner-scoped lookup. A row owned by someone else is reported as not found,
 * so IDs cannot be probed across users.
 */
export function getOwned<T extends Owned>(rows: T[], id: string, actor: Actor, what: string): T {
  const row = rows.find((r) => r.id === id);
  if (!row || row.ownerId !== actor.userId) {
    throw new AppError('not_found', `${what} not found.`);
  }
  return row;
}

export function listOwned<T extends { ownerId: string }>(rows: T[], actor: Actor): T[] {
  return rows.filter((r) => r.ownerId === actor.userId);
}

/** Only a signed-in human may take review, approval or outbound-related actions. */
export function requireHuman(actor: Actor, action: string): void {
  if (actor.kind !== 'human') {
    throw new AppError('approval_required', `${action} requires an explicit action by the human operator.`);
  }
}

/** Audit log is append-only: this is the only writer and nothing updates or deletes entries. */
export function appendAudit(
  db: Db,
  ctx: Pick<Ctx, 'actor' | 'now'>,
  action: string,
  targetType: string,
  targetId: string,
  detail: string,
  /** Use 'system' for automatic consequences (run finished, claim invalidated), so the log never credits them to the human. */
  actorKind: Actor['kind'] = ctx.actor.kind,
): AuditEvent {
  const event: AuditEvent = {
    id: newId('aud'),
    ownerId: ctx.actor.userId,
    actorKind,
    action,
    targetType,
    targetId,
    detail: detail.slice(0, 300),
    at: ctx.now().toISOString(),
  };
  db.auditEvents.push(event);
  return event;
}
