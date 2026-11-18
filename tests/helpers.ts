import { loadConfig, type AppConfig } from '@/lib/config';
import type { Ctx } from '@/lib/context';
import { MockRuleReasoner, type Reasoner } from '@/lib/reasoning/reasoner';
import { loadGoldenCase } from '@/lib/services/businesses';
import { startInvestigation } from '@/lib/services/investigations';
import { MockFixtureTransport } from '@/lib/sources/mock-transport';
import type { PageTransport } from '@/lib/sources/transport';
import { MemoryStore, type Store } from '@/lib/store';
import type { ActorKind, Business, Db, InvestigationRun } from '@/lib/types';

export const NOW = new Date('2026-11-18T12:00:00Z');

export function makeCtx(
  opts: {
    store?: Store;
    userId?: string;
    kind?: ActorKind;
    config?: Partial<AppConfig>;
    transport?: PageTransport;
    reasoner?: Reasoner;
    now?: () => Date;
  } = {},
): Ctx {
  return {
    store: opts.store ?? new MemoryStore(),
    config: { ...loadConfig({}), ...opts.config },
    actor: { userId: opts.userId ?? 'usr_a', kind: opts.kind ?? 'human' },
    now: opts.now ?? (() => NOW),
    transport: opts.transport ?? new MockFixtureTransport(),
    reasoner: opts.reasoner ?? new MockRuleReasoner(),
  };
}

export async function runGolden(ctx: Ctx, key: string, index = 0): Promise<{ run: InvestigationRun; business: Business; db: Db }> {
  const businesses = loadGoldenCase(ctx, key);
  const business = businesses[index]!;
  const run = await startInvestigation(ctx, { businessId: business.id });
  const db = ctx.store.snapshot();
  return { run, business: db.businesses.find((b) => b.id === business.id)!, db };
}

export function liveOpps(db: Db, runId: string) {
  return db.opportunities.filter((o) => o.runId === runId && o.status !== 'invalidated');
}

export function activeEv(db: Db, runId: string) {
  return db.evidence.filter((e) => e.runId === runId && !e.supersededBy);
}
