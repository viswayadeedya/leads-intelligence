import { NextResponse } from 'next/server';
import { isAppError } from '@/lib/errors';
import { ctxFromRequest } from '@/lib/runtime';
import { getRunDetail } from '@/lib/services/investigations';

/** GET /api/investigations/:id — status, cost and errors. `restricted` is reported distinctly from other states. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = ctxFromRequest(request);
    const { id } = await params;
    const d = getRunDetail(ctx, id);
    return NextResponse.json(
      {
        id: d.run.id,
        mode: d.run.mode,
        synthetic: d.business.synthetic,
        status: d.run.status,
        stages: d.stages.map((s) => ({ key: s.key, status: s.status, note: s.note })),
        requestsUsed: d.run.requestsUsed,
        requestCap: d.run.requestCap,
        spentCents: d.run.spentCents,
        budgetCents: d.run.budgetCents,
        errors: d.run.errorSummary,
        unknowns: d.run.unknowns.map((u) => ({ question: u.question, reason: u.reason })),
        sources: d.sources.map((s) => ({ url: s.sourceUrl, accessStatus: s.accessStatus, detail: s.accessDetail, retrievedAt: s.retrievedAt, synthetic: s.synthetic })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (isAppError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.httpStatus });
    return NextResponse.json({ error: 'internal', message: 'Unexpected error.' }, { status: 500 });
  }
}
