'use server';

// Server Actions: the only way the UI changes data. Every action re-validates
// the session (requireCtx), calls an owner-scoped service, and redirects to a
// path built from server-known IDs (never from a client-supplied URL).

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { changePassphrase, completeSetup, setNotice, SESSION_COOKIE, signIn, signOut, signOutEverywhere } from '@/lib/auth';
import type { Ctx } from '@/lib/context';
import { isAppError } from '@/lib/errors';
import { logEvent } from '@/lib/log';
import { getConfig, getSetupSink, getStore, requireCtx } from '@/lib/runtime';
import { confirmIdentity, createBusiness, loadGoldenCase, resolveDuplicate } from '@/lib/services/businesses';
import { addManualEvidence, getEvidenceDesk, reviewEvidence } from '@/lib/services/evidence';
import { cancelInvestigation, resumeInvestigation, retryFailedSources, startInvestigation } from '@/lib/services/investigations';
import { approveOutreach, createOutreachDraft, logDraftCopied, markSentManually, saveOutreachDraft } from '@/lib/services/outreach';
import { approveReport, approveShare, decideOpportunity } from '@/lib/services/reports';

const str = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};
const opt = (form: FormData, name: string): string | undefined => {
  const v = str(form, name).trim();
  return v === '' ? undefined : v;
};

type Result = { to: string; ok?: string };

/** Runs an action, turns failures into an operator-readable notice, then redirects. */
async function act(fallback: string, fn: (ctx: Ctx) => Promise<Result> | Result): Promise<never> {
  const ctx = await requireCtx();
  let to = fallback;
  let notice: { kind: 'ok' | 'error'; text: string } | null = null;
  try {
    const result = await fn(ctx);
    to = result.to;
    if (result.ok) notice = { kind: 'ok', text: result.ok };
  } catch (e) {
    if (isAppError(e)) {
      notice = { kind: 'error', text: e.message };
    } else {
      logEvent({ action: 'ui.action', result: 'error', error: e instanceof Error ? e.name : 'unknown' });
      notice = { kind: 'error', text: 'That did not work because of an unexpected error. Nothing was sent or approved. Try again; if it repeats, check the server log.' };
    }
  }
  if (notice) {
    const id = setNotice(ctx.store, ctx.actor.userId, notice.kind, notice.text);
    to += `${to.includes('?') ? '&' : '?'}n=${id}`;
  }
  redirect(to);
}

async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: getConfig().sessionTtlMinutes * 60,
  });
}

/** Error codes shown on the sign-in page. Only fixed messages are displayed; no detail about why a secret failed. */
function signInFailure(e: unknown): string {
  if (!isAppError(e)) throw e;
  if (e.code === 'rate_limited') return 'locked';
  if (e.code === 'validation') return 'weak';
  if (e.code === 'forbidden') return 'unavailable';
  return 'bad';
}

/** First run: one-time setup code from the data folder, plus a passphrase the operator chooses. */
export async function setupAction(form: FormData): Promise<void> {
  let outcome = 'ok';
  try {
    const token = completeSetup(getStore(), getConfig(), process.env, new Date(), getSetupSink(), {
      code: str(form, 'code'),
      passphrase: str(form, 'passphrase'),
      confirm: str(form, 'confirm'),
    });
    await setSessionCookie(token);
  } catch (e) {
    outcome = signInFailure(e);
    if (outcome === 'weak' && isAppError(e) && /match/.test(e.message)) outcome = 'mismatch';
  }
  redirect(outcome === 'ok' ? '/' : `/login?e=${outcome}`);
}

export async function signInAction(form: FormData): Promise<void> {
  let outcome = 'ok';
  try {
    await setSessionCookie(signIn(getStore(), getConfig(), process.env, new Date(), str(form, 'passphrase')));
  } catch (e) {
    outcome = signInFailure(e);
  }
  redirect(outcome === 'ok' ? '/' : `/login?e=${outcome}`);
}

export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  signOut(getStore(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

export async function signOutEverywhereAction(): Promise<void> {
  await act('/settings', async (ctx) => {
    const jar = await cookies();
    const ended = signOutEverywhere(ctx.store, ctx.now(), jar.get(SESSION_COOKIE)?.value);
    return { to: '/settings', ok: `${ended} other session(s) ended. This one stays signed in.` };
  });
}

export async function changePassphraseAction(form: FormData): Promise<void> {
  await act('/settings', async (ctx) => {
    const jar = await cookies();
    changePassphrase(ctx.store, process.env, ctx.now(), {
      current: str(form, 'current'),
      next: str(form, 'next'),
      confirm: str(form, 'confirm'),
      keepToken: jar.get(SESSION_COOKIE)?.value,
    });
    return { to: '/settings', ok: 'Passphrase changed. Every other session was signed out.' };
  });
}

export async function createBusinessAction(form: FormData): Promise<void> {
  await act('/discover', (ctx) => {
    const business = createBusiness(ctx, {
      displayName: str(form, 'displayName'),
      domain: opt(form, 'domain'),
      phone: opt(form, 'phone'),
      city: str(form, 'city'),
      state: str(form, 'state'),
    });
    return {
      to: '/discover',
      ok: business.possibleDuplicateOf
        ? `Added ${business.displayName}. It looks like a duplicate of an existing entry; decide below before investigating.`
        : `Added ${business.displayName}. Choose "Investigate" to start.`,
    };
  });
}

export async function investigateExampleAction(form: FormData): Promise<void> {
  await act('/discover', async (ctx) => {
    const [business] = loadGoldenCase(ctx, str(form, 'key'));
    const run = await startInvestigation(ctx, { businessId: business!.id });
    return { to: `/investigations/${run.id}` };
  });
}

export async function loadExampleAction(form: FormData): Promise<void> {
  await act('/discover', (ctx) => {
    const loaded = loadGoldenCase(ctx, str(form, 'key'));
    return { to: '/discover', ok: `Loaded ${loaded.length} synthetic business(es). They are fictional and labelled MOCK.` };
  });
}

export async function startInvestigationAction(form: FormData): Promise<void> {
  await act('/discover', async (ctx) => {
    const run = await startInvestigation(ctx, { businessId: str(form, 'businessId'), idempotencyKey: opt(form, 'idempotencyKey') ?? null });
    return { to: `/investigations/${run.id}` };
  });
}

export async function resumeAction(form: FormData): Promise<void> {
  const runId = str(form, 'runId');
  await act(`/investigations/${encodeURIComponent(runId)}`, async (ctx) => {
    const run = await resumeInvestigation(ctx, runId);
    return { to: `/investigations/${run.id}` };
  });
}

export async function retryAction(form: FormData): Promise<void> {
  const runId = str(form, 'runId');
  await act(`/investigations/${encodeURIComponent(runId)}`, async (ctx) => {
    const run = await retryFailedSources(ctx, runId);
    return { to: `/investigations/${run.id}`, ok: run.status === 'review_ready' ? 'Retry succeeded. All planned pages were inspected.' : 'Retry finished. Some sources are still unavailable.' };
  });
}

export async function cancelAction(form: FormData): Promise<void> {
  const runId = str(form, 'runId');
  await act(`/investigations/${encodeURIComponent(runId)}`, (ctx) => {
    const run = cancelInvestigation(ctx, runId);
    return { to: `/investigations/${run.id}`, ok: 'Investigation stopped. Evidence collected so far was kept.' };
  });
}

export async function confirmIdentityAction(form: FormData): Promise<void> {
  const runId = str(form, 'runId');
  await act(`/investigations/${encodeURIComponent(runId)}`, async (ctx) => {
    confirmIdentity(ctx, str(form, 'businessId'), str(form, 'reason'));
    const run = await resumeInvestigation(ctx, runId);
    return { to: `/investigations/${run.id}`, ok: 'Identity confirmed by you and recorded in the audit log. The investigation continued.' };
  });
}

export async function resolveDuplicateAction(form: FormData): Promise<void> {
  const runId = opt(form, 'runId');
  const back = runId ? `/investigations/${encodeURIComponent(runId)}` : '/discover';
  await act(back, async (ctx) => {
    const resolution = str(form, 'resolution') === 'marked_duplicate' ? 'marked_duplicate' : 'kept_separate';
    resolveDuplicate(ctx, str(form, 'businessId'), resolution, str(form, 'reason'));
    if (runId && resolution === 'kept_separate') {
      const run = await resumeInvestigation(ctx, runId);
      return { to: `/investigations/${run.id}`, ok: 'Kept as a separate business. The investigation continued.' };
    }
    return { to: back, ok: resolution === 'marked_duplicate' ? 'Marked as a duplicate. It will not be investigated.' : 'Kept as a separate business.' };
  });
}

export async function reviewEvidenceAction(form: FormData): Promise<void> {
  const runId = str(form, 'runId');
  const evidenceId = str(form, 'evidenceId');
  const filter = opt(form, 'filter');
  const back = `/evidence/${encodeURIComponent(runId)}?ev=${encodeURIComponent(evidenceId)}${filter ? `&f=${encodeURIComponent(filter)}` : ''}`;
  await act(back, async (ctx) => {
    const raw = str(form, 'decision');
    const decision = raw === 'accepted' || raw === 'rejected' || raw === 'needs_verification' ? raw : null;
    if (!decision) return { to: back };
    const ev = await reviewEvidence(ctx, evidenceId, decision, str(form, 'note'));
    const label = decision === 'accepted' ? 'accepted' : decision === 'rejected' ? 'rejected' : 'marked as needing verification';
    // Move on to the next observation that still needs a decision, so review is one click per item.
    const next = getEvidenceDesk(ctx, ev.runId).items.find((i) => i.evidence.verificationStatus === 'needs_review');
    return {
      to: `/evidence/${ev.runId}?ev=${(next?.evidence ?? ev).id}${filter ? `&f=${encodeURIComponent(filter)}` : ''}`,
      ok: `Observation ${label}. Opportunities and the report were updated, and the decision is in the audit log. ${next ? 'Showing the next observation that needs a decision.' : 'Every observation now has a decision.'}`,
    };
  });
}

export async function addManualEvidenceAction(form: FormData): Promise<void> {
  const runId = str(form, 'runId');
  await act(`/evidence/${encodeURIComponent(runId)}`, async (ctx) => {
    const ev = await addManualEvidence(ctx, {
      runId,
      kind: str(form, 'kind'),
      observation: str(form, 'observation'),
      observedAt: str(form, 'observedAt'),
      sourceUrl: opt(form, 'sourceUrl'),
      sourceAccess: str(form, 'sourceAccess'),
      sensitivity: str(form, 'sensitivity'),
      identityMatch: str(form, 'identityMatch'),
      topic: str(form, 'topic'),
      stance: str(form, 'stance'),
      query: opt(form, 'query'),
      queryLocation: opt(form, 'queryLocation'),
    });
    return { to: `/evidence/${ev.runId}?ev=${ev.id}`, ok: `Observation recorded as "${ev.sensitivity}". It needs your review decision like any other.` };
  });
}

export async function decideOpportunityAction(form: FormData): Promise<void> {
  const reportId = str(form, 'reportId');
  await act(`/reports/${encodeURIComponent(reportId)}`, (ctx) => {
    const decision = str(form, 'decision') === 'accepted' ? 'accepted' : 'rejected';
    decideOpportunity(ctx, str(form, 'opportunityId'), decision, str(form, 'reason'));
    return { to: `/reports/${encodeURIComponent(reportId)}`, ok: `Opportunity ${decision}.` };
  });
}

export async function approveReportAction(form: FormData): Promise<void> {
  const reportId = str(form, 'reportId');
  await act(`/reports/${encodeURIComponent(reportId)}`, (ctx) => {
    const report = approveReport(ctx, reportId, str(form, 'hash'));
    return { to: `/reports/${report.id}`, ok: 'Report approved for internal use. It has not been shared with anyone.' };
  });
}

export async function approveShareAction(form: FormData): Promise<void> {
  const reportId = str(form, 'reportId');
  await act(`/reports/${encodeURIComponent(reportId)}?view=owner`, (ctx) => {
    const report = approveShare(ctx, reportId, str(form, 'hash'));
    return { to: `/reports/${report.id}?view=owner`, ok: 'Owner version approved. You can now download it. Nothing was sent.' };
  });
}

export async function createOutreachAction(form: FormData): Promise<void> {
  const reportId = str(form, 'reportId');
  await act(`/reports/${encodeURIComponent(reportId)}`, (ctx) => {
    const draft = createOutreachDraft(ctx, reportId, str(form, 'opportunityId'));
    return { to: `/outreach?d=${draft.id}`, ok: 'Draft created. Nothing was sent. Edit it, then approve the exact text.' };
  });
}

export async function saveOutreachAction(form: FormData): Promise<void> {
  const draftId = str(form, 'draftId');
  await act(`/outreach?d=${encodeURIComponent(draftId)}`, (ctx) => {
    const draft = saveOutreachDraft(ctx, draftId, str(form, 'subject'), str(form, 'body'));
    return { to: `/outreach?d=${draft.id}`, ok: draft.status === 'draft' ? 'Draft saved. Any earlier approval no longer applies.' : 'Draft saved.' };
  });
}

function approvalCookie(draftId: string): string {
  return `oi_apr_${draftId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export async function approveOutreachAction(form: FormData): Promise<void> {
  const draftId = str(form, 'draftId');
  await act(`/outreach?d=${encodeURIComponent(draftId)}`, async (ctx) => {
    const { draft, approvalToken } = approveOutreach(ctx, draftId, str(form, 'hash'));
    // The one-time approval token stays in an HttpOnly cookie; page scripts cannot read it.
    const jar = await cookies();
    jar.set(approvalCookie(draft.id), approvalToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: ctx.config.approvalTtlMinutes * 60,
    });
    return { to: `/outreach?d=${draft.id}`, ok: `You approved this exact text. The approval expires in ${ctx.config.approvalTtlMinutes} minutes. Nothing was sent; copy it and send it yourself.` };
  });
}

export async function markSentAction(form: FormData): Promise<void> {
  const draftId = str(form, 'draftId');
  await act(`/outreach?d=${encodeURIComponent(draftId)}`, async (ctx) => {
    const jar = await cookies();
    const name = approvalCookie(draftId);
    const token = jar.get(name)?.value ?? '';
    const draft = markSentManually(ctx, draftId, token);
    jar.delete(name);
    return { to: `/outreach?d=${draft.id}`, ok: 'Recorded as sent by you. The app itself sent nothing.' };
  });
}

/** Called from the copy button. Logs "copied, not sent". */
export async function logCopiedAction(draftId: string): Promise<{ ok: boolean }> {
  const ctx = await requireCtx();
  try {
    logDraftCopied(ctx, draftId);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
