import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cancelAction, confirmIdentityAction, resolveDuplicateAction, retryAction } from '../../actions';
import { Field, MockBadge, NoticeBanner, PageHeader, StatusBadge, Time } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { isAppError } from '@/lib/errors';
import { shortId } from '@/lib/ids';
import { requireCtx } from '@/lib/runtime';
import { getRunDetail, type RunDetail } from '@/lib/services/investigations';

const STAGE_NAMES: Record<string, string> = {
  identity: '1. Identity',
  website: '2. Website',
  public_signals: '3. Public signals',
  evidence_review: '4. Evidence review',
  report: '5. Report',
};

const ERROR_WORDS: Record<string, string> = {
  access_denied: 'Access restricted',
  source_unavailable: 'Source unavailable',
  rate_limited: 'Rate limited',
  identity_ambiguous: 'Identity ambiguous',
  extraction_failed: 'Processing failed',
  model_invalid_output: 'Reasoner output invalid',
  budget_exceeded: 'Budget reached',
  security_blocked: 'Blocked for safety',
  timeout: 'Timed out',
  duplicate_unresolved: 'Possible duplicate',
};

function summary(detail: RunDetail): string {
  const { run } = detail;
  switch (run.status) {
    case 'review_ready':
      return 'Collection finished and every planned source was inspected. The observations now need your review.';
    case 'partial':
      return 'Collection finished, but not every source could be inspected. What was collected is kept; what is missing is listed below as unknown, not as a finding.';
    case 'blocked':
      return 'Stopped before collecting evidence because a decision is needed from you. See “What needs you” below.';
    case 'failed':
      return 'The investigation failed. No conclusions were drawn from it.';
    case 'canceled':
      return 'You stopped this investigation. Evidence collected before that was kept.';
    default:
      return 'This investigation has not finished. If this page was reloaded mid-run, wait a moment and reload.';
  }
}

export default async function InvestigationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ n?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { n } = await searchParams;
  let detail: RunDetail;
  try {
    detail = getRunDetail(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') notFound();
    throw e;
  }
  const { run, business, sources, stages } = detail;
  const identityBlocked = run.status === 'blocked' && run.errorSummary.some((e) => e.code === 'identity_ambiguous');
  const duplicateBlocked = run.status === 'blocked' && run.errorSummary.some((e) => e.code === 'duplicate_unresolved');
  const finished = run.status === 'review_ready' || run.status === 'partial';
  const canStop = ['queued', 'blocked', 'partial'].includes(run.status);

  return (
    <>
      <PageHeader
        crumbs={[{ href: '/', label: 'Home' }, { href: '/investigations', label: 'Investigations' }, { label: business.displayName }]}
        title={`Investigating ${business.displayName}`}
        badges={
          <>
            <StatusBadge status={run.status} /> {business.synthetic ? <MockBadge /> : null}
          </>
        }
        subtitle={summary(detail)}
        actions={
          finished ? (
            <Link className="btn-link btn-primary" href={`/evidence/${run.id}`}>
              View evidence
            </Link>
          ) : undefined
        }
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />

      {run.mode === 'mock' ? (
        <div className="callout">
          <strong>This run used mock data.</strong>{' '}
          {business.synthetic
            ? 'The business and its website are fictional fixtures. Do not treat any of this as research about a real company.'
            : 'Mock mode does not fetch real websites, so the website stage was not checked. Only observations you record by hand are real.'}
        </div>
      ) : null}

      <ol className="stages" aria-label="Investigation stages">
        {stages.map((s) => (
          <li className="stage" key={s.key}>
            <span className="stage-name">{STAGE_NAMES[s.key]}</span>
            <StatusBadge status={s.status} />
            <p className="stage-note">{s.note || 'Not started.'}</p>
          </li>
        ))}
      </ol>

      {identityBlocked || duplicateBlocked ? (
        <section className="card" aria-labelledby="needs-h">
          <h2 id="needs-h">What needs you</h2>
          {identityBlocked ? (
            <>
              <p>The website could not be matched to this business with confidence, so no evidence was collected. Attributing a source to the wrong company is the costliest mistake this tool can make.</p>
              <ul>
                {business.identityNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <form action={confirmIdentityAction}>
                <input type="hidden" name="runId" value={run.id} />
                <input type="hidden" name="businessId" value={business.id} />
                <Field label="How did you confirm this is the right business?" hint="Recorded in the audit log. If you are not sure, stop the investigation instead.">
                  <input type="text" name="reason" required minLength={3} maxLength={200} />
                </Field>
                <button type="submit" className="btn-primary">
                  Confirm identity and continue
                </button>
              </form>
            </>
          ) : null}
          {duplicateBlocked ? (
            <>
              <p>
                This entry looks like a duplicate of <strong>{detail.duplicateOf?.displayName ?? 'another entry'}</strong>
                {detail.duplicateOf?.domain ? ` (${detail.duplicateOf.domain})` : ''}. Nothing was fetched. Decide before investigating so the same company is not researched twice under two names.
              </p>
              <form action={resolveDuplicateAction}>
                <input type="hidden" name="runId" value={run.id} />
                <input type="hidden" name="businessId" value={business.id} />
                <Field label="Reason for your decision">
                  <input type="text" name="reason" required minLength={3} maxLength={200} />
                </Field>
                <div className="button-row">
                  <button type="submit" name="resolution" value="kept_separate" className="btn-primary">
                    Keep separate and continue
                  </button>
                  <button type="submit" name="resolution" value="marked_duplicate">
                    Mark as duplicate
                  </button>
                </div>
              </form>
            </>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="sources-h">
        <h2 id="sources-h">Sources</h2>
        {sources.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No source was inspected.</p>
            <p>{stages.find((s) => s.key === 'website')?.note || 'Nothing has been requested yet.'}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last checked</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td className="break">
                      {s.sourceType === 'website' ? s.sourceUrl : `Manual observation${s.sourceUrl ? `: ${s.sourceUrl}` : ' (no shareable link)'}`}
                      <br />
                      <span className="muted small">
                        {s.provider} · {s.permittedStorageClass} · ID {shortId(s.id)}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={s.accessStatus} />
                    </td>
                    <td>
                      <Time iso={s.retrievedAt} />
                    </td>
                    <td>
                      {s.accessDetail}
                      {s.attempts > 1 ? ` · ${s.attempts} attempts` : ''}
                      {s.accessStatus === 'restricted' ? ' · Not retried: restricted sources are respected, not worked around.' : ''}
                      {s.retryable ? ' · Can be retried.' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="button-row">
          {detail.canRetry ? (
            <form action={retryAction}>
              <input type="hidden" name="runId" value={run.id} />
              <button type="submit">
                Retry failed source ({run.retriesUsed} of {ctx.config.maxRetries} retries used)
              </button>
            </form>
          ) : null}
          {canStop ? (
            <form action={cancelAction}>
              <input type="hidden" name="runId" value={run.id} />
              <button type="submit" className="btn-danger">
                Stop investigation
              </button>
            </form>
          ) : null}
        </div>
      </section>

      <div className="grid-2">
        <section className="card" aria-labelledby="problems-h">
          <h2 id="problems-h">Problems during this run</h2>
          {run.errorSummary.length === 0 ? (
            <p className="muted">None recorded.</p>
          ) : (
            <ul>
              {run.errorSummary.map((e) => (
                <li key={`${e.code}-${e.message}`}>
                  <strong>{ERROR_WORDS[e.code] ?? e.code}:</strong> {e.message}
                </li>
              ))}
            </ul>
          )}
          <h3>Unknowns (not findings)</h3>
          {run.unknowns.length === 0 ? (
            <p className="muted">None recorded from sources. How calls and requests are handled inside the business is always unknown until the owner says.</p>
          ) : (
            <ul>
              {run.unknowns.map((u) => (
                <li key={u.id}>
                  <strong>{u.question}</strong> {u.reason}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="result-h">
          <h2 id="result-h">What this run produced</h2>
          <dl className="details">
            <dt>Observations</dt>
            <dd>
              {detail.evidenceCounts.total} total · {detail.evidenceCounts.needsReview} need review · {detail.evidenceCounts.accepted} accepted · {detail.evidenceCounts.rejected} rejected
            </dd>
            <dt>Candidate opportunities</dt>
            <dd>{detail.opportunityCount === 0 ? (finished ? 'None. “No finding” is a valid outcome.' : 'None yet') : detail.opportunityCount}</dd>
            <dt>Claims rejected by verifier</dt>
            <dd>{detail.rejections.length}</dd>
            <dt>Requests used</dt>
            <dd>
              {run.requestsUsed} of {run.requestCap}
            </dd>
            <dt>Spend</dt>
            <dd>
              {run.spentCents} of {run.budgetCents} cents
            </dd>
            <dt>Reasoner</dt>
            <dd>{run.modelVersion} (rule-based mock; no AI model was called)</dd>
            <dt>Started / finished</dt>
            <dd>
              <Time iso={run.startedAt} /> / <Time iso={run.finishedAt} />
            </dd>
            <dt>Run ID</dt>
            <dd className="mono">{run.id}</dd>
          </dl>
          {detail.rejections.length > 0 ? (
            <details>
              <summary>Why {detail.rejections.length} proposed claim(s) were rejected</summary>
              <ul>
                {detail.rejections.map((r) => (
                  <li key={r.id}>
                    <strong>{r.proposalTitle}:</strong> {r.message} <span className="muted small">({r.code})</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="button-row">
            {finished ? (
              <Link className="btn-link" href={`/evidence/${run.id}`}>
                View evidence
              </Link>
            ) : null}
            {detail.reportId && finished ? (
              <Link className="btn-link" href={`/reports/${detail.reportId}`}>
                Open report
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
