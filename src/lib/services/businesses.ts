import { z } from 'zod';
import { findCaseByKey } from '@/fixtures/golden';
import { appendAudit, getOwned, listOwned, requireHuman, type Ctx } from '../context';
import { AppError } from '../errors';
import { findPossibleDuplicate, normalizeDomain, normalizeName } from '../identity';
import { newId } from '../ids';
import type { Business, Db } from '../types';

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // no control characters
    .regex(/^[^\u0000-\u001f\u007f]*$/);

// Explicit allowlist of fields: prevents mass assignment of ownerId, synthetic, identityStatus, etc.
export const BusinessInputSchema = z.strictObject({
  displayName: line(120),
  domain: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).regex(/^[0-9()+.\- x]*$/).optional(),
  city: line(80),
  state: z.string().trim().regex(/^[A-Za-z]{2}$/),
});
export type BusinessInput = z.infer<typeof BusinessInputSchema>;

function insertBusiness(db: Db, ctx: Ctx, input: BusinessInput, synthetic: boolean, fixtureKey: string | null): Business {
  const domain = input.domain && input.domain.trim() !== '' ? normalizeDomain(input.domain) : null;
  const normalizedName = normalizeName(input.displayName);
  if (!normalizedName) throw new AppError('validation', 'Enter a business name.');
  const mine = listOwned(db.businesses, ctx.actor);
  const candidate = {
    normalizedName,
    domain,
    phone: input.phone && input.phone.trim() !== '' ? input.phone.trim() : null,
    city: input.city,
    state: input.state.toUpperCase(),
  };
  const duplicate = findPossibleDuplicate(candidate, mine);
  const business: Business = {
    id: newId('biz'),
    ownerId: ctx.actor.userId,
    displayName: input.displayName,
    address: null,
    category: 'hvac',
    externalIds: {},
    identityStatus: 'unverified',
    identityNotes: [],
    synthetic,
    fixtureKey,
    possibleDuplicateOf: duplicate ? duplicate.otherId : null,
    duplicateResolution: duplicate ? 'unresolved' : null,
    createdAt: ctx.now().toISOString(),
    ...candidate,
  };
  db.businesses.push(business);
  appendAudit(db, ctx, 'business.created', 'business', business.id, duplicate ? `Created; flagged as possible duplicate (${duplicate.reason}).` : 'Created.');
  return business;
}

export function createBusiness(ctx: Ctx, raw: unknown): Business {
  const parsed = BusinessInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation', 'Check the business name, city and two-letter state. Phone may contain digits and ( ) + - . only.');
  }
  return ctx.store.transact((db) => insertBusiness(db, ctx, parsed.data, false, null));
}

/** Loads a bundled FICTIONAL example. Idempotent per operator: reuses existing rows. */
export function loadGoldenCase(ctx: Ctx, key: string): Business[] {
  const golden = findCaseByKey(key);
  if (!golden) throw new AppError('not_found', 'Synthetic example not found.');
  return ctx.store.transact((db) => {
    const mine = listOwned(db.businesses, ctx.actor);
    return golden.businesses.map((b) => {
      const existing = mine.find((m) => m.fixtureKey === key && m.domain === b.domain);
      if (existing) return existing;
      return insertBusiness(db, ctx, { displayName: b.displayName, domain: b.domain, phone: b.phone ?? undefined, city: b.city, state: b.state }, true, key);
    });
  });
}

export function listBusinesses(ctx: Ctx): Business[] {
  return listOwned(ctx.store.snapshot().businesses, ctx.actor).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBusiness(ctx: Ctx, id: string): Business {
  return getOwned(ctx.store.snapshot().businesses, id, ctx.actor, 'Business');
}

export function resolveDuplicate(ctx: Ctx, businessId: string, resolution: 'kept_separate' | 'marked_duplicate', reason: string): Business {
  requireHuman(ctx.actor, 'Resolving a duplicate');
  const why = reason.trim().slice(0, 200);
  if (why.length < 3) throw new AppError('validation', 'Give a short reason for this decision.');
  return ctx.store.transact((db) => {
    const business = getOwned(db.businesses, businessId, ctx.actor, 'Business');
    if (!business.possibleDuplicateOf) throw new AppError('conflict', 'This business is not flagged as a possible duplicate.');
    business.duplicateResolution = resolution;
    appendAudit(db, ctx, 'business.duplicate_resolved', 'business', business.id, `${resolution}: ${why}`);
    return business;
  });
}

/** Manual override after the identity stage stopped. Recorded in the audit log. */
export function confirmIdentity(ctx: Ctx, businessId: string, reason: string): Business {
  requireHuman(ctx.actor, 'Confirming business identity');
  const why = reason.trim().slice(0, 200);
  if (why.length < 3) throw new AppError('validation', 'Say briefly how you confirmed this is the right business.');
  return ctx.store.transact((db) => {
    const business = getOwned(db.businesses, businessId, ctx.actor, 'Business');
    business.identityStatus = 'confirmed_by_operator';
    appendAudit(db, ctx, 'business.identity_confirmed_manually', 'business', business.id, why);
    return business;
  });
}
