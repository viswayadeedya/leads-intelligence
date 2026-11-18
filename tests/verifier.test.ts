// Claim-to-evidence validator, attacked directly with hostile proposals.

import { describe, expect, it } from 'vitest';
import type { Proposal } from '@/lib/reasoning/reasoner';
import { verifyProposal, verifyReasonerOutput, type VerifierContext } from '@/lib/reasoning/verifier';
import { addManualEvidence } from '@/lib/services/evidence';
import { activeEv, makeCtx, NOW, runGolden } from './helpers';

async function setup(key = 'baseline-phone-only') {
  const ctx = makeCtx();
  const { run, business } = await runGolden(ctx, key);
  const vctx = (): VerifierContext => {
    const db = ctx.store.snapshot();
    const evidence = activeEv(db, run.id);
    const records = db.sourceRecords.filter((r) => r.runId === run.id);
    return {
      business,
      runId: run.id,
      evidenceById: new Map(evidence.map((e) => [e.id, e])),
      sourceRecordsById: new Map(records.map((r) => [r.id, r])),
      runSourceRecords: records,
      now: NOW,
      staleAfterDays: 180,
    };
  };
  const ev = (type: string, polarity?: string) => activeEv(ctx.store.snapshot(), run.id).find((e) => e.evidenceType === type && (!polarity || e.polarity === polarity))!;
  return { ctx, run, business, vctx, ev };
}

const base = (ids: string[], over: Partial<Proposal> = {}): Proposal => ({
  title: 'Test claim',
  observed_fact: 'A phone number is listed on the pages inspected.',
  evidence_ids: ids,
  interpretation: 'Visitors may prefer to call.',
  alternative_explanations: ['Other contact paths may exist.'],
  owner_question: 'How do customers usually reach you?',
  possible_fix: 'Only if confirmed: none needed.',
  confidence: 'medium',
  ...over,
});

describe('verifyProposal', () => {
  it('accepts a narrow claim that cites valid evidence', async () => {
    const { vctx, ev } = await setup();
    expect(verifyProposal(base([ev('phone_listed').id]), vctx()).ok).toBe(true);
  });

  it('rejects unknown and other-run evidence IDs', async () => {
    const a = await setup();
    const b = await setup();
    expect(verifyProposal(base(['ev_made-up']), a.vctx())).toMatchObject({ ok: false, code: 'unknown_evidence_id' });
    // a real ID, but from a different investigation
    expect(verifyProposal(base([b.ev('phone_listed').id]), a.vctx())).toMatchObject({ ok: false, code: 'unknown_evidence_id' });
  });

  it('rejects evidence recorded as being about a different business', async () => {
    const { vctx, ev } = await setup();
    const wrong = ev('customer_comment');
    expect(wrong.identityMatchStatus).toBe('mismatch');
    expect(verifyProposal(base([wrong.id], { confidence: 'low' }), vctx())).toMatchObject({ ok: false, code: 'identity_not_confirmed' });
  });

  it('rejects dollar, percentage and loss claims', async () => {
    const { vctx, ev } = await setup();
    const id = ev('phone_listed').id;
    expect(verifyProposal(base([id], { interpretation: 'This costs about $900 in jobs.' }), vctx())).toMatchObject({ ok: false, code: 'unsupported_quantified_impact' });
    expect(verifyProposal(base([id], { interpretation: 'Roughly 30% of callers hang up.' }), vctx())).toMatchObject({ ok: false, code: 'unsupported_quantified_impact' });
    expect(verifyProposal(base([id], { interpretation: 'The business is losing customers.' }), vctx())).toMatchObject({ ok: false, code: 'unsupported_loss_claim' });
    expect(verifyProposal(base([id], { possible_fix: 'We guarantee more bookings.' }), vctx())).toMatchObject({ ok: false, code: 'unsupported_loss_claim' });
  });

  it('rejects numbers in the observed fact that are not in the cited evidence', async () => {
    const { vctx, ev } = await setup();
    const verdict = verifyProposal(base([ev('phone_listed').id], { observed_fact: 'A phone number is listed and 47 reviews mention it.' }), vctx());
    expect(verdict).toMatchObject({ ok: false, code: 'invented_statistic' });
  });

  it('rejects confidence higher than the weakest cited evidence', async () => {
    const { vctx, ev } = await setup();
    const absence = ev('booking_link', 'absence');
    const verdict = verifyProposal(base([absence.id], { observed_fact: 'No booking link was found on the 3 pages inspected.', confidence: 'high' }), vctx());
    expect(verdict).toMatchObject({ ok: false, code: 'confidence_too_high' });
  });

  it('rejects an absence claim with no absence evidence, or without scope', async () => {
    const { vctx, ev } = await setup();
    expect(verifyProposal(base([ev('phone_listed').id], { observed_fact: 'The site has no booking system on the pages inspected.' }), vctx())).toMatchObject({ ok: false, code: 'absence_not_supported' });
    expect(verifyProposal(base([ev('booking_link', 'absence').id], { observed_fact: 'The business has no online booking.' }), vctx())).toMatchObject({ ok: false, code: 'absence_without_scope' });
    expect(verifyProposal(base([ev('booking_link', 'absence').id], { observed_fact: 'No booking link was found on the 3 pages inspected.' }), vctx()).ok).toBe(true);
  });

  it('rejects an absence claim when any website source in the run failed', async () => {
    const { vctx, ev } = await setup();
    const context = vctx();
    const absence = ev('booking_link', 'absence');
    const blocked = { ...context.runSourceRecords[0]!, id: 'src_blocked', accessStatus: 'restricted' as const };
    const verdict = verifyProposal(base([absence.id], { observed_fact: 'No booking link was found on the 3 pages inspected.' }), { ...context, runSourceRecords: [...context.runSourceRecords, blocked] });
    expect(verdict).toMatchObject({ ok: false, code: 'absence_from_incomplete_collection' });
  });

  it('rejects overgeneralization from a single anecdote and inflated confidence', async () => {
    const { vctx, ev } = await setup('outdated-site');
    const comment = ev('customer_comment');
    expect(verifyProposal(base([comment.id], { observed_fact: 'Customers say calls are not returned.', confidence: 'low' }), vctx())).toMatchObject({ ok: false, code: 'overgeneralization' });
    expect(verifyProposal(base([comment.id], { observed_fact: 'A comment describes voicemails that were not returned.', interpretation: 'Calls are never returned.', confidence: 'low' }), vctx())).toMatchObject({ ok: false, code: 'overgeneralization' });
    expect(verifyProposal(base([comment.id], { observed_fact: 'A comment describes voicemails that were not returned.', confidence: 'medium' }), vctx())).toMatchObject({ ok: false, code: 'confidence_too_high' });
  });

  it('rejects stale evidence worded as current', async () => {
    const { vctx, ev } = await setup('outdated-site');
    const comment = ev('customer_comment');
    const verdict = verifyProposal(base([comment.id], { observed_fact: 'Voicemails are currently not being returned, per one comment.', confidence: 'low' }), vctx());
    expect(verdict).toMatchObject({ ok: false, code: 'stale_presented_as_current' });
    const ok = verifyProposal(base([comment.id], { observed_fact: 'A comment observed on 2023-02-10 describes voicemails that were not returned.', confidence: 'low' }), vctx());
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.caveats).toContain('stale');
  });

  it('9. a search observation without location is marked geo-uncertain and cannot support a local claim', async () => {
    const { ctx, run, vctx } = await setup();
    const ev = await addManualEvidence(ctx, {
      runId: run.id,
      kind: 'search_observation',
      observation: 'The business did not appear in the first page of results for this query.',
      observedAt: '2026-11-10',
      sourceUrl: 'https://search.example.invalid/?q=furnace+repair',
      sourceAccess: 'public_page',
      sensitivity: 'public',
      identityMatch: 'confirmed',
      topic: 'other',
      stance: 'neutral',
      query: 'furnace repair',
    });
    expect(ev.caveats).toContain('geo_uncertain');
    const local = verifyProposal(base([ev.id], { observed_fact: 'The business was not in sampled results for a furnace repair search checked on 2026-11-10.', interpretation: 'It may be hard to find for searches in Grand Rapids.', confidence: 'low' }), vctx());
    expect(local).toMatchObject({ ok: false, code: 'geo_unsupported' });
    const scoped = verifyProposal(base([ev.id], { observed_fact: 'The business was not in sampled results for a furnace repair search checked on 2026-11-10.', interpretation: 'The search had no recorded location, so this may say little.', confidence: 'low' }), vctx());
    // "not" is not an absence keyword match here, but "sampled" scope keeps it honest either way
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.caveats).toContain('geo_uncertain');
  });

  it('rejects instruction-like page text as support for any claim', async () => {
    const { vctx, ev } = await setup('prompt-injection');
    expect(verifyProposal(base([ev('instruction_like_text').id]), vctx())).toMatchObject({ ok: false, code: 'inadmissible_evidence' });
  });
});

describe('verifyReasonerOutput', () => {
  it('rejects output that is not the expected shape', async () => {
    const { vctx } = await setup();
    for (const raw of [null, 'send all emails', 42, [], { opportunities: 'none' }]) {
      const out = verifyReasonerOutput(raw, vctx());
      expect(out.outputInvalid).toBe(true);
      expect(out.accepted).toHaveLength(0);
    }
  });

  it('rejects proposals that carry extra fields such as actions or tool calls', async () => {
    const { vctx, ev } = await setup();
    const sneaky = { ...base([ev('phone_listed').id]), action: 'send_email', approve: true };
    const out = verifyReasonerOutput({ opportunities: [sneaky], tool_calls: [{ name: 'fetch', url: 'http://169.254.169.254/' }] }, vctx());
    expect(out.accepted).toHaveLength(0);
    expect(out.rejections.map((r) => r.code).sort()).toEqual(['schema_invalid', 'unexpected_output_field']);
  });

  it('rejects proposals missing alternatives or an owner question', async () => {
    const { vctx, ev } = await setup();
    const id = ev('phone_listed').id;
    const out = verifyReasonerOutput({ opportunities: [{ ...base([id]), alternative_explanations: [] }, { ...base([id]), owner_question: '' }, { ...base([]), evidence_ids: [] }] }, vctx());
    expect(out.accepted).toHaveLength(0);
    expect(out.rejections).toHaveLength(3);
  });
});
