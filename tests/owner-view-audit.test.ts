// Audit of everything that can reach a business owner: the owner view object,
// the Markdown export, the stored approved snapshot and the outreach draft.
//
// Method: plant a unique marker in every internal-only free-text field of the
// database, build the owner outputs, and fail on any marker that comes out.
// The owner view must be an allowlist, so the test also pins its exact keys.

import { describe, expect, it } from 'vitest';
import { NO_ONLINE_PATH_TITLE } from '@/fixtures/golden';
import type { Ctx } from '@/lib/context';
import type { Reasoner, ReasonerInput } from '@/lib/reasoning/reasoner';
import { reviewEvidence } from '@/lib/services/evidence';
import { retryFailedSources } from '@/lib/services/investigations';
import { createOutreachDraft } from '@/lib/services/outreach';
import { approveReport, approveShare, buildOwnerView, decideOpportunity, exportOwnerReport, getReportBundle, isOwnerSafeEvidence, renderOwnerMarkdown } from '@/lib/services/reports';
import type { Db } from '@/lib/types';
import { activeEv, liveOpps, makeCtx, NOW, runGolden } from './helpers';

const PRIVATE_MARKER = 'PRIVATE-GROUP-MARKER-7731';

async function acceptEverything(ctx: Ctx, runId: string): Promise<void> {
  for (const ev of activeEv(ctx.store.snapshot(), runId)) {
    if (ev.identityMatchStatus === 'confirmed') await reviewEvidence(ctx, ev.id, 'accepted', '');
    else await reviewEvidence(ctx, ev.id, 'rejected', 'Different business.');
  }
  for (const opp of liveOpps(ctx.store.snapshot(), runId)) decideOpportunity(ctx, opp.id, 'accepted', 'Reviewed.');
}

const reportIdOf = (db: Db, runId: string) => db.reports.find((r) => r.runId === runId)!.id;

/** Everything an owner could be handed for this run, as one string. */
function ownerOutputs(db: Db, runId: string): string {
  const { view } = buildOwnerView(db, runId, NOW, 180);
  return `${JSON.stringify(view)}\n${renderOwnerMarkdown(view)}`;
}

/**
 * Appends a unique marker to every internal-only free-text field and returns
 * marker -> field path. Fields that are legitimately owner-facing (business
 * name, city, state, domain, and the text of accepted public evidence and of
 * included findings) are left alone.
 */
function taintInternalFields(db: Db, runId: string): Map<string, string> {
  const paths = new Map<string, string>();
  let n = 0;
  const mark = (path: string): string => {
    const m = ` LEAK${String(++n).padStart(4, '0')}X`;
    paths.set(m.trim(), path);
    return m;
  };
  const records = new Map(db.sourceRecords.filter((r) => r.runId === runId).map((r) => [r.id, r]));
  const safeEvidenceIds = new Set(db.evidence.filter((e) => e.runId === runId && !e.supersededBy && isOwnerSafeEvidence(e, records)).map((e) => e.id));

  for (const b of db.businesses) {
    b.identityNotes = [...b.identityNotes, 'note'].map((s, i) => s + mark(`business.identityNotes[${i}]`));
    b.phone = (b.phone ?? '') + mark('business.phone');
    b.address = (b.address ?? '') + mark('business.address');
    b.category += mark('business.category');
    b.normalizedName += mark('business.normalizedName');
    b.externalIds = { place: `x${mark('business.externalIds.place')}` };
  }
  for (const r of db.runs) {
    for (const s of r.stages) s.note += mark(`run.stages.${s.key}.note`);
    r.errorSummary.push({ code: 'timeout', message: `m${mark('run.errorSummary.message')}` });
    for (const [i, u] of r.unknowns.entries()) {
      u.question += mark(`run.unknowns[${i}].question`);
      u.reason += mark(`run.unknowns[${i}].reason`);
    }
    r.robots.text = (r.robots.text ?? '') + mark('run.robots.text');
    r.modelVersion += mark('run.modelVersion');
    r.idempotencyKey = `k${mark('run.idempotencyKey')}`;
  }
  for (const s of db.sourceRecords) {
    s.accessDetail += mark(`sourceRecord(${s.sourceType}).accessDetail`);
    s.notes += mark(`sourceRecord(${s.sourceType}).notes`);
    s.provider += mark(`sourceRecord(${s.sourceType}).provider`);
    s.queryContext = { ...s.queryContext, extra: `q${mark(`sourceRecord(${s.sourceType}).queryContext`)}` };
    s.checksum = (s.checksum ?? '') + mark(`sourceRecord(${s.sourceType}).checksum`);
    if (s.extracted) {
      s.extracted.title += mark('sourceRecord.extracted.title');
      s.extracted.afterHours = (s.extracted.afterHours ?? '') + mark('sourceRecord.extracted.afterHours');
      s.extracted.hours = (s.extracted.hours ?? '') + mark('sourceRecord.extracted.hours');
      s.extracted.instructionLike = (s.extracted.instructionLike ?? '') + mark('sourceRecord.extracted.instructionLike');
      s.extracted.phones = [...s.extracted.phones, `p${mark('sourceRecord.extracted.phones')}`];
    }
  }
  for (const e of db.evidence) {
    e.reviewNote = (e.reviewNote ?? '') + mark('evidence.reviewNote');
    e.supportingExcerpt = (e.supportingExcerpt ?? '') + mark('evidence.supportingExcerpt');
    e.locator = { ...e.locator, extra: `l${mark('evidence.locator')}` };
    e.checksum += mark('evidence.checksum');
    if (!safeEvidenceIds.has(e.id)) {
      e.observation += mark(`evidence(not owner-safe, ${e.sensitivity}, ${e.verificationStatus}).observation`);
      e.confidenceRationale += mark('evidence(not owner-safe).confidenceRationale');
    }
  }
  for (const o of db.opportunities) o.decisionReason = (o.decisionReason ?? '') + mark('opportunity.decisionReason');
  for (const v of db.verifierRejections) {
    v.message += mark('verifierRejection.message');
    v.proposalTitle += mark('verifierRejection.proposalTitle');
  }
  db.verifierRejections.push({ id: 'rej_x', ownerId: 'usr_a', runId, code: `c${mark('verifierRejection.code')}`, message: `m${mark('verifierRejection.message(new)')}`, proposalTitle: `t${mark('verifierRejection.proposalTitle(new)')}`, at: NOW.toISOString() });
  for (const a of db.auditEvents) a.detail += mark('auditEvent.detail');
  for (const u of db.users) u.label += mark('user.label');
  return paths;
}

function leaks(output: string, paths: Map<string, string>): string[] {
  return [...new Set((output.match(/LEAK\d{4}X/g) ?? []).map((m) => paths.get(m) ?? m))].sort();
}

describe('owner view: run.unknowns (question and reason)', () => {
  it('an unknown written as free text never reaches the owner view or export, in question or in reason', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    // Simulates any present or future code path (or a corrupted row) that
    // records an unknown containing restricted material.
    ctx.store.transact((db) => {
      const r = db.runs.find((x) => x.id === run.id)!;
      r.unknowns.push({
        id: 'unk_planted',
        question: `Whether the complaint in the members-only group (${PRIVATE_MARKER}-Q) is typical is unknown.`,
        reason: `Only one member, Pat in the neighborhood group, said so (${PRIVATE_MARKER}-R).`,
        sourceRecordIds: [],
      });
    });
    const db = ctx.store.snapshot();
    const out = ownerOutputs(db, run.id);
    expect(out).not.toContain(`${PRIVATE_MARKER}-Q`);
    expect(out).not.toContain(`${PRIVATE_MARKER}-R`);
    expect(out).not.toContain('members-only');
    expect(out).not.toContain('Pat in the neighborhood');
    // The operator is told something was held back.
    expect(buildOwnerView(db, run.id, NOW, 180).redaction.unknownsWithheld).toBe(1);
    // The internal view still shows it.
    expect(JSON.stringify(getReportBundle(ctx, reportIdOf(db, run.id)).internal)).toContain(`${PRIVATE_MARKER}-Q`);
  });

  it('an unknown that points at a non-public source record is withheld even if its structure looks valid', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    ctx.store.transact((db) => {
      const note = db.sourceRecords.find((s) => s.runId === run.id && s.sourceType === 'manual_observation')!;
      db.runs.find((x) => x.id === run.id)!.unknowns.push({
        id: 'unk_forged',
        kind: 'feature_not_concluded',
        topic: 'booking_link',
        inspectedCount: 3,
        unreachedPlannedCount: 0,
        budgetExhausted: false,
        question: 'q',
        reason: 'r',
        sourceRecordIds: [note.id],
      } as never);
    });
    const { view, redaction } = buildOwnerView(ctx.store.snapshot(), run.id, NOW, 180);
    expect(view.unknowns).toEqual([]);
    expect(redaction.unknownsWithheld).toBe(1);
  });

  it.each(['flaky-timeout', 'site-403', 'robots-disallow', 'booking-page-403'])('%s: real pipeline unknowns reach the owner as fixed wording, with no internal diagnostics', async (key) => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, key);
    const db = ctx.store.snapshot();
    expect(db.runs.find((r) => r.id === run.id)!.unknowns.length).toBeGreaterThan(0);
    const { view, redaction } = buildOwnerView(db, run.id, NOW, 180);
    // Still honest with the owner: the gap is stated, not hidden.
    expect(view.unknowns.length).toBeGreaterThan(0);
    expect(redaction.unknownsWithheld).toBe(0);
    const text = `${JSON.stringify(view.unknowns)}\n${renderOwnerMarkdown(view)}`;
    for (const internal of ['budget', 'robots.txt could not be read', 'safe-fetch', 'No synthetic fixture for this address', 'Timed out', 'HTTP 4', 'HTTP 5', 'retry', 'Retry']) {
      expect(text, `owner text must not contain "${internal}"`).not.toContain(internal);
    }
    expect(text).toMatch(/does not mean it does not exist|not a finding about the business/);
  });

  it('budget exhaustion is described to the owner without naming the budget', async () => {
    const ctx = makeCtx({ config: { maxRequests: 2 } });
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    const db = ctx.store.snapshot();
    expect(db.runs.find((r) => r.id === run.id)!.budgetExhausted).toBe(true);
    const { view } = buildOwnerView(db, run.id, NOW, 180);
    const text = JSON.stringify(view.unknowns);
    expect(view.unknowns.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/budget|request|cent/i);
    expect(text).toContain('before every planned page was read');
  });
});

describe('owner view: field-by-field taint sweep', () => {
  it('no internal-only field reaches the owner view or the Markdown export (finding included)', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    const db = ctx.store.snapshot();
    db.runs.find((r) => r.id === run.id)!.unknowns.push({ id: 'unk_x', question: 'Q', reason: 'R', sourceRecordIds: [] });
    const paths = taintInternalFields(db, run.id);
    expect(paths.size).toBeGreaterThan(40);
    const { view } = buildOwnerView(db, run.id, NOW, 180);
    expect(view.opportunities.map((o) => o.title)).toEqual([NO_ONLINE_PATH_TITLE]);
    expect(leaks(ownerOutputs(db, run.id), paths)).toEqual([]);
  });

  it.each(['flaky-timeout', 'site-403', 'contradictory-comments', 'prompt-injection', 'invented-revenue', 'outdated-site'])('no internal-only field reaches the owner outputs: %s', async (key) => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, key);
    await acceptEverything(ctx, run.id);
    const db = ctx.store.snapshot();
    const paths = taintInternalFields(db, run.id);
    expect(leaks(ownerOutputs(db, run.id), paths)).toEqual([]);
  });

  it('the owner view is an allowlist: its keys are exactly these', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    const { view } = buildOwnerView(ctx.store.snapshot(), run.id, NOW, 180);
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(view)).toEqual(['audience', 'business', 'executiveFinding', 'investigatedAt', 'journey', 'methodology', 'opportunities', 'ownerQuestions', 'possibleImprovements', 'sources', 'synthetic', 'unknowns']);
    expect(keys(view.business)).toEqual(['city', 'displayName', 'domain', 'identity', 'state']);
    expect(keys(view.opportunities[0]!)).toEqual(['alternatives', 'caveats', 'confidence', 'evidence', 'interpretation', 'observedFact', 'ownerQuestion', 'possibleFix', 'title']);
    expect(keys(view.opportunities[0]!.evidence[0]!)).toEqual(['caveats', 'confidence', 'observation', 'observedAt', 'rationale', 'shortId', 'sources', 'stale']);
    expect(keys(view.opportunities[0]!.evidence[0]!.sources[0]!)).toEqual(['label', 'url']);
    expect(keys(view.sources[0]!)).toEqual(['retrievedAt', 'status', 'url']);
    expect(keys(view.journey[0]!)).toEqual(['detail', 'state', 'step']);
    // No internal identifiers: full evidence, opportunity, run, report or source IDs.
    expect(JSON.stringify(view)).not.toMatch(/\b(?:ev|opp|run|rep|src|usr|unk)_[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('a website source whose address is not on the business domain is not listed for the owner', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    const db = ctx.store.snapshot();
    const rec = db.sourceRecords.find((s) => s.runId === run.id && s.sourceType === 'website')!;
    rec.sourceUrl = 'https://tracker.example.net/redirected?session=abc';
    const { view, redaction } = buildOwnerView(db, run.id, NOW, 180);
    expect(JSON.stringify(view)).not.toContain('tracker.example.net');
    expect(renderOwnerMarkdown(view)).not.toContain('tracker.example.net');
    expect(redaction.sourcesWithheld).toBeGreaterThanOrEqual(1);
  });

  it('the owner is not told that an observation was reviewed and held back', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    for (const ev of activeEv(ctx.store.snapshot(), run.id)) {
      if (ev.identityMatchStatus !== 'confirmed') await reviewEvidence(ctx, ev.id, 'rejected', 'Different business.');
      else if (ev.evidenceType === 'booking_link') await reviewEvidence(ctx, ev.id, 'rejected', 'I found a booking widget by hand.');
      else await reviewEvidence(ctx, ev.id, 'accepted', '');
    }
    const out = ownerOutputs(ctx.store.snapshot(), run.id);
    expect(out).not.toMatch(/not accepted in review|awaiting review|rejected|I found a booking widget/i);
  });
});

describe('owner view: text written by the reasoner', () => {
  /** Copies restricted material it was shown into a claim that cites only public evidence. */
  class LeakyReasoner implements Reasoner {
    readonly version = 'leaky-test-reasoner';
    seen: string[][] = [];
    async propose(input: ReasonerInput): Promise<unknown> {
      this.seen.push(input.evidence.map((e) => e.observation));
      const secret = input.evidence.find((e) => e.observation.includes(PRIVATE_MARKER));
      const pub = input.evidence.filter((e) => e.type === 'phone_listed');
      if (pub.length === 0) return { opportunities: [] };
      return {
        opportunities: [
          {
            title: 'Phone contact path',
            observed_fact: 'A phone number is listed on the pages inspected.',
            evidence_ids: pub.map((e) => e.id),
            interpretation: secret ? `Relevant context: ${secret.observation}` : 'Phone may be the main contact path.',
            alternative_explanations: ['The business may prefer phone contact.'],
            owner_question: 'How are calls handled when the office is closed?',
            possible_fix: 'Only if the owner confirms a gap: after-hours call capture.',
            confidence: 'low',
          },
        ],
      };
    }
  }

  it('a claim citing only public evidence cannot carry restricted text the reasoner was shown', async () => {
    const reasoner = new LeakyReasoner();
    const ctx = makeCtx({ reasoner });
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    const db = ctx.store.snapshot();
    // The restricted note exists and the reasoner was shown it at least once (internal context).
    expect(reasoner.seen.some((obs) => obs.some((o) => o.includes(PRIVATE_MARKER)))).toBe(true);
    // No stored claim that is eligible for the owner contains it.
    const out = ownerOutputs(db, run.id);
    expect(out).not.toContain(PRIVATE_MARKER);
    expect(out).not.toContain('members-only');
    for (const o of db.opportunities.filter((x) => x.runId === run.id && x.status !== 'invalidated')) {
      const text = JSON.stringify([o.title, o.observedFact, o.interpretation, o.alternativeExplanations, o.ownerQuestion, o.possibleFix]);
      if (text.includes(PRIVATE_MARKER)) expect(o.reasonedFrom).toBe('includes_restricted');
    }
    // The clean, public-only version of the claim is what the owner gets.
    const { view } = buildOwnerView(db, run.id, NOW, 180);
    expect(view.opportunities.map((o) => o.title)).toEqual(['Phone contact path']);
    expect(view.opportunities[0]!.interpretation).toBe('Phone may be the main contact path.');
  });

  it('a claim with no recorded reasoning context is withheld from the owner (fail closed)', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'baseline-phone-only');
    await acceptEverything(ctx, run.id);
    const db = ctx.store.snapshot();
    expect(buildOwnerView(db, run.id, NOW, 180).view.opportunities).toHaveLength(1);
    for (const o of db.opportunities) delete (o as { reasonedFrom?: string }).reasonedFrom;
    const { view, redaction } = buildOwnerView(db, run.id, NOW, 180);
    expect(view.opportunities).toHaveLength(0);
    expect(redaction.opportunitiesWithheld).toHaveLength(1);
  });
});

describe('owner export: the approved text is re-checked when it is exported', () => {
  async function approvedShare(key: string) {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, key);
    await acceptEverything(ctx, run.id);
    const id = reportIdOf(ctx.store.snapshot(), run.id);
    const bundle = getReportBundle(ctx, id);
    approveReport(ctx, id, bundle.internalHash);
    approveShare(ctx, id, bundle.ownerHash);
    return { ctx, run, id, bundle };
  }

  it('refuses a stored snapshot that was altered after approval', async () => {
    const { ctx, id } = await approvedShare('private-group-note');
    ctx.store.transact((db) => {
      db.reports.find((r) => r.id === id)!.sharedSnapshot += `\n- ${PRIVATE_MARKER}`;
    });
    expect(() => exportOwnerReport(ctx, id)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
    const report = ctx.store.snapshot().reports.find((r) => r.id === id)!;
    expect(report.status).toBe('approved_internal');
    expect(report.sharedSnapshot).toBeNull();
    expect(ctx.store.snapshot().auditEvents.some((a) => a.action === 'report.share_approval_withdrawn' && a.actorKind === 'system')).toBe(true);
  });

  it('refuses when the owner version would now be different from what was approved', async () => {
    const { ctx, run, id } = await approvedShare('private-group-note');
    // A source is reclassified without touching anything the internal view shows.
    ctx.store.transact((db) => {
      for (const s of db.sourceRecords.filter((x) => x.runId === run.id && x.sourceType === 'website')) s.permittedStorageClass = 'RESTRICTED_SOURCE';
    });
    expect(() => exportOwnerReport(ctx, id)).toThrowError(expect.objectContaining({ code: 'approval_required' }));
    expect(ctx.store.snapshot().reports.find((r) => r.id === id)!.status).toBe('approved_internal');
  });

  it('exports exactly the approved text when nothing changed', async () => {
    const { ctx, id, bundle } = await approvedShare('private-group-note');
    expect(exportOwnerReport(ctx, id).markdown).toBe(bundle.ownerMarkdown);
  });
});

describe('outreach draft: built only from owner-view fields', () => {
  it('contains no internal-only field and no restricted text', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    await acceptEverything(ctx, run.id);
    const id = reportIdOf(ctx.store.snapshot(), run.id);
    approveReport(ctx, id, getReportBundle(ctx, id).internalHash);
    let paths = new Map<string, string>();
    ctx.store.transact((db) => {
      paths = taintInternalFields(db, run.id);
    });
    // Tainting changed internal content, so the report must be approved again.
    const again = getReportBundle(ctx, id);
    if (again.report.status !== 'approved_internal') approveReport(ctx, id, again.internalHash);
    const opp = liveOpps(ctx.store.snapshot(), run.id).find((o) => o.title === NO_ONLINE_PATH_TITLE)!;
    const draft = createOutreachDraft(ctx, id, opp.id);
    expect(leaks(`${draft.subject}\n${draft.body}`, paths)).toEqual([]);
    expect(`${draft.subject}\n${draft.body}`).not.toContain(PRIVATE_MARKER);
  });
});

describe('retry keeps owner unknowns consistent', () => {
  it('after a successful retry no unknown remains for the owner', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'flaky-timeout');
    expect(buildOwnerView(ctx.store.snapshot(), run.id, NOW, 180).view.unknowns.length).toBeGreaterThan(0);
    await retryFailedSources(ctx, run.id);
    expect(buildOwnerView(ctx.store.snapshot(), run.id, NOW, 180).view.unknowns).toEqual([]);
  });
});
