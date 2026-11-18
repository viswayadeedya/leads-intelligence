// Evidence desk operations: manual observations and human review decisions.

import { z } from 'zod';
import type { FixtureNote } from '@/fixtures/golden';
import { appendAudit, getOwned, requireHuman, type Ctx } from '../context';
import { AppError } from '../errors';
import { newId, sha256 } from '../ids';
import type { Caveat, Confidence, Db, Evidence, InvestigationRun, Sensitivity, SourceRecord, StorageClass } from '../types';
import { activeEvidence, analyzeRun, contradictoryIds } from './analysis';

const plain = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max);

// Every field is required to be stated: manual evidence needs provenance and a privacy class.
export const ManualEvidenceSchema = z.strictObject({
  runId: z.string().min(1).max(80),
  kind: z.enum(['customer_comment', 'owner_statement', 'search_observation', 'operator_observation']),
  observation: plain(10, 500),
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceUrl: z.string().trim().max(500).optional(),
  sourceAccess: z.enum(['public_page', 'login_required', 'private_group']),
  sensitivity: z.enum(['public', 'restricted', 'personal']),
  identityMatch: z.enum(['confirmed', 'uncertain', 'mismatch']),
  topic: z.enum(['callback', 'booking', 'contact', 'punctuality', 'other']),
  stance: z.enum(['reports_problem', 'reports_positive', 'neutral']),
  query: z.string().trim().max(200).optional(),
  queryLocation: z.string().trim().max(100).optional(),
});
export type ManualEvidenceInput = z.infer<typeof ManualEvidenceSchema>;

const PERSONAL_DETAIL = /[\w.+-]+@[\w-]+\.[\w.-]+|(?:^|\s)@\w{2,}|\bu\/\w{2,}/;

function validateSourceUrl(raw: string | undefined): string | null {
  if (!raw || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('validation', 'The source link is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('validation', 'The source link must start with http:// or https://.');
  if (url.username || url.password) throw new AppError('validation', 'The source link must not contain credentials.');
  return url.toString();
}

const KIND_META: Record<ManualEvidenceInput['kind'], { confidence: Confidence; rationale: string; caveats: Caveat[] }> = {
  customer_comment: { confidence: 'low', rationale: 'One manually recorded account. Not independently corroborated; it does not show how common the experience is.', caveats: ['anecdotal'] },
  owner_statement: { confidence: 'low', rationale: 'Reported by someone presenting as the owner. Identity and context should be verified directly.', caveats: ['anecdotal'] },
  search_observation: { confidence: 'low', rationale: 'A sampled search result recorded by hand. Snippets can be truncated and results vary by place and time.', caveats: [] },
  operator_observation: { confidence: 'medium', rationale: 'Seen directly by the operator. Not machine-reproducible.', caveats: [] },
};

function insertManualEvidence(db: Db, ctx: Ctx, run: InvestigationRun, input: ManualEvidenceInput, synthetic: boolean): Evidence {
  const sourceUrl = validateSourceUrl(input.sourceUrl);
  if (input.sourceAccess === 'public_page' && !sourceUrl) {
    throw new AppError('validation', 'A public source needs its link so the claim can be checked.');
  }
  if (PERSONAL_DETAIL.test(input.observation)) {
    throw new AppError('validation', 'Remove email addresses and usernames. Paraphrase the observation without identifying the person.');
  }
  const observedAt = new Date(`${input.observedAt}T00:00:00Z`);
  if (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > ctx.now().getTime() + 86_400_000) {
    throw new AppError('validation', 'The observation date is not valid or is in the future.');
  }
  if (input.kind === 'search_observation' && (!input.query || input.query.trim() === '')) {
    throw new AppError('validation', 'A search observation needs the exact query that was used.');
  }
  // Fail closed: gated sources can never be classified public.
  const sensitivity: Sensitivity = input.sourceAccess !== 'public_page' && input.sensitivity === 'public' ? 'restricted' : input.sensitivity;
  const storageClass: StorageClass = sensitivity === 'personal' ? 'PERSONAL' : sensitivity === 'restricted' ? 'RESTRICTED_SOURCE' : 'PUBLIC_BUSINESS';

  const dedupeKey = `manual:${sha256(JSON.stringify([input.kind, input.observation, input.observedAt, sourceUrl]))}`;
  if (db.evidence.some((e) => e.runId === run.id && e.dedupeKey === dedupeKey)) {
    throw new AppError('conflict', 'This observation is already recorded for this investigation.');
  }

  const meta = KIND_META[input.kind];
  const caveats = [...meta.caveats];
  const location = input.queryLocation && input.queryLocation.trim() !== '' ? input.queryLocation.trim() : null;
  if (input.kind === 'search_observation' && !location) caveats.push('geo_uncertain');

  const now = ctx.now().toISOString();
  const record: SourceRecord = {
    id: newId('src'),
    ownerId: run.ownerId,
    runId: run.id,
    businessId: run.businessId,
    sourceType: 'manual_observation',
    sourceUrl,
    provider: synthetic ? 'synthetic-fixture-note' : 'operator',
    retrievedAt: now,
    accessStatus: 'ok',
    accessDetail:
      input.sourceAccess === 'public_page' ? 'Public page, reviewed by hand' : input.sourceAccess === 'login_required' ? 'Login required; reviewed by hand, not collected automatically' : 'Private group; reviewed by hand, not collected automatically',
    permittedStorageClass: storageClass,
    queryContext: { sourceAccess: input.sourceAccess, query: input.query?.trim() || null, queryLocation: location },
    checksum: null,
    notes: '',
    attempts: 1,
    retryable: false,
    extracted: null,
    synthetic,
  };
  db.sourceRecords.push(record);

  const evidence: Evidence = {
    id: newId('ev'),
    ownerId: run.ownerId,
    runId: run.id,
    sourceRecordIds: [record.id],
    businessId: run.businessId,
    evidenceType: input.kind,
    polarity: 'neutral',
    observation: input.observation,
    supportingExcerpt: null,
    locator: { query: input.query?.trim() || null, queryLocation: location, sourceAccess: input.sourceAccess },
    observedAt: observedAt.toISOString(),
    identityMatchStatus: input.identityMatch,
    verificationStatus: 'needs_review',
    reviewNote: null,
    sensitivity,
    confidence: meta.confidence,
    confidenceRationale: meta.rationale,
    caveats,
    topic: input.topic,
    stance: input.stance,
    dedupeKey,
    checksum: sha256(input.observation),
    supersededBy: null,
    synthetic,
    createdAt: now,
  };
  db.evidence.push(evidence);
  appendAudit(db, ctx, synthetic ? 'evidence.fixture_note_seeded' : 'evidence.manual_added', 'evidence', evidence.id, `${input.kind}; sensitivity ${sensitivity}; identity ${input.identityMatch}.`, synthetic ? 'system' : ctx.actor.kind);
  return evidence;
}

export async function addManualEvidence(ctx: Ctx, raw: unknown): Promise<Evidence> {
  requireHuman(ctx.actor, 'Recording a manual observation');
  const parsed = ManualEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation', 'Fill in every field: what was observed (10 to 500 characters), the date, source access, privacy class, identity match, topic and stance.');
  }
  const evidence = ctx.store.transact((db) => {
    const run = getOwned(db.runs, parsed.data.runId, ctx.actor, 'Investigation');
    if (run.status === 'canceled') throw new AppError('conflict', 'This investigation was stopped.');
    return insertManualEvidence(db, ctx, run, parsed.data, false);
  });
  await analyzeRun(ctx, parsed.data.runId);
  return evidence;
}

/** Seeds bundled fictional notes for a synthetic case. Idempotent. */
export function seedFixtureNotes(db: Db, ctx: Ctx, run: InvestigationRun, notes: FixtureNote[]): number {
  let added = 0;
  for (const note of notes) {
    try {
      insertManualEvidence(
        db,
        ctx,
        run,
        {
          runId: run.id,
          kind: note.kind,
          observation: note.observation,
          observedAt: note.observedAt.slice(0, 10),
          sourceUrl: note.sourceUrl ?? undefined,
          sourceAccess: note.sourceAccess,
          sensitivity: note.sensitivity,
          identityMatch: note.identityMatch,
          topic: note.topic as ManualEvidenceInput['topic'],
          stance: note.stance,
          query: note.query,
          queryLocation: note.queryLocation ?? undefined,
        },
        true,
      );
      added++;
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'conflict')) throw e;
    }
  }
  return added;
}

export async function reviewEvidence(
  ctx: Ctx,
  evidenceId: string,
  decision: 'accepted' | 'rejected' | 'needs_verification',
  note: string,
): Promise<Evidence> {
  requireHuman(ctx.actor, 'Reviewing evidence');
  const why = note.trim().slice(0, 300);
  if (decision !== 'accepted' && why.length < 3) {
    throw new AppError('validation', 'Give a short reason so the decision can be understood later.');
  }
  const evidence = ctx.store.transact((db) => {
    const ev = getOwned(db.evidence, evidenceId, ctx.actor, 'Evidence');
    if (ev.supersededBy) throw new AppError('conflict', 'This observation was replaced by a newer one.');
    if (decision === 'accepted' && ev.identityMatchStatus === 'mismatch') {
      throw new AppError('conflict', 'This observation is recorded as being about a different business, so it cannot be accepted for this one.');
    }
    ev.verificationStatus = decision;
    ev.reviewNote = why || null;
    appendAudit(db, ctx, `evidence.${decision}`, 'evidence', ev.id, why || 'Accepted.');
    return ev;
  });
  await analyzeRun(ctx, evidence.runId);
  return evidence;
}

export type EvidenceDeskItem = { evidence: Evidence; sources: SourceRecord[]; contradictory: boolean; stale: boolean };

export function getEvidenceDesk(ctx: Ctx, runId: string): { run: InvestigationRun; items: EvidenceDeskItem[]; superseded: number } {
  const db = ctx.store.snapshot();
  const run = getOwned(db.runs, runId, ctx.actor, 'Investigation');
  const active = activeEvidence(db, runId);
  const contradictions = contradictoryIds(active);
  const cutoff = ctx.now().getTime() - ctx.config.staleAfterDays * 86_400_000;
  const records = new Map(db.sourceRecords.filter((r) => r.runId === runId).map((r) => [r.id, r]));
  return {
    run,
    superseded: db.evidence.filter((e) => e.runId === runId && e.supersededBy).length,
    items: active
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((evidence) => ({
        evidence,
        sources: evidence.sourceRecordIds.map((id) => records.get(id)).filter((r): r is SourceRecord => Boolean(r)),
        contradictory: contradictions.has(evidence.id),
        stale: new Date(evidence.observedAt).getTime() < cutoff,
      })),
  };
}
