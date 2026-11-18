import { NextResponse } from 'next/server';
import { isAppError } from '@/lib/errors';
import { ctxFromRequest } from '@/lib/runtime';
import { exportOwnerReport } from '@/lib/services/reports';

/** GET /api/reports/:id/export — the exact owner version the operator approved. Never the internal view. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = ctxFromRequest(request);
    const { id } = await params;
    const { filename, markdown } = exportOwnerReport(ctx, id);
    return new NextResponse(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json({ error: e.code, message: e.message }, { status: e.httpStatus });
    return NextResponse.json({ error: 'internal', message: 'Unexpected error.' }, { status: 500 });
  }
}
