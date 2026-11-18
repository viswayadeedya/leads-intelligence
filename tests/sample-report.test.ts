// Produces the sample report referenced by docs/delivery/CLAUDE_REVIEW_PACKET.md.
// Always asserts; writes files only when WRITE_SAMPLE=1 so normal test runs
// leave the repository untouched.
//   WRITE_SAMPLE=1 npx vitest run tests/sample-report.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reviewEvidence } from '@/lib/services/evidence';
import { approveReport, approveShare, decideOpportunity, exportOwnerReport, getReportBundle } from '@/lib/services/reports';
import { activeEv, liveOpps, makeCtx, runGolden } from './helpers';

describe('sample report (synthetic "private-group-note" case)', () => {
  it('internal view cites evidence IDs; owner version is redacted', async () => {
    const ctx = makeCtx();
    const { run } = await runGolden(ctx, 'private-group-note');
    for (const ev of activeEv(ctx.store.snapshot(), run.id)) await reviewEvidence(ctx, ev.id, 'accepted', '');
    for (const opp of liveOpps(ctx.store.snapshot(), run.id)) decideOpportunity(ctx, opp.id, 'accepted', 'Reviewed against source.');
    const reportId = ctx.store.snapshot().reports.find((r) => r.runId === run.id)!.id;
    const bundle = getReportBundle(ctx, reportId);
    approveReport(ctx, reportId, bundle.internalHash);
    approveShare(ctx, reportId, bundle.ownerHash);
    const exported = exportOwnerReport(ctx, reportId);

    const internal = {
      note: 'SYNTHETIC. Internal view of a fictional business. Evidence IDs are regenerated on every run.',
      executiveFinding: bundle.internal.executiveFinding,
      journey: bundle.internal.journey,
      opportunities: bundle.internal.opportunities.map((o) => ({
        title: o.title,
        observedFact: o.observedFact,
        confidence: o.confidence,
        caveats: o.caveats,
        evidence: o.evidence.map((e) => ({ id: e.id, sensitivity: e.sensitivity, observation: e.observation, observedAt: e.observedAt, sources: e.sources.map((s) => s.url ?? s.label) })),
      })),
      redaction: bundle.redaction,
    };

    expect(internal.opportunities).toHaveLength(2);
    expect(internal.opportunities.every((o) => o.evidence.length > 0)).toBe(true);
    expect(JSON.stringify(internal)).toContain('PRIVATE-GROUP-MARKER-7731');
    expect(exported.markdown).not.toContain('PRIVATE-GROUP-MARKER-7731');
    expect(bundle.redaction.opportunitiesWithheld).toHaveLength(1);

    if (process.env.WRITE_SAMPLE === '1') {
      const dir = path.resolve(import.meta.dirname, '..', 'docs', 'examples');
      fs.writeFileSync(path.join(dir, 'SAMPLE_MOCK_REPORT_INTERNAL.json'), `${JSON.stringify(internal, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'SAMPLE_MOCK_REPORT_OWNER.md'), exported.markdown);
    }
  });
});
