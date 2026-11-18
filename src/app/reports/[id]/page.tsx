import Link from 'next/link';
import { notFound } from 'next/navigation';
import { approveReportAction, approveShareAction, createOutreachAction, decideOpportunityAction } from '../../actions';
import { Badge, Caveats, Field, MockBadge, NoticeBanner, PageHeader, StatusBadge, Time } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { isAppError } from '@/lib/errors';
import { requireCtx } from '@/lib/runtime';
import { getReportBundle, type EvidenceView, type OpportunityView, type OwnerReportView, type ReportBundle, type ReportView } from '@/lib/services/reports';

function SourceDrawer({ evidence, runId, internal }: { evidence: EvidenceView; runId: string; internal: boolean }) {
  return (
    <details>
      <summary>
        View source: <span className="mono">{evidence.shortId}</span> {evidence.observation.slice(0, 70)}
        {evidence.observation.length > 70 ? '…' : ''}
      </summary>
      <p>{evidence.observation}</p>
      {evidence.excerpt ? <blockquote className="excerpt">{evidence.excerpt}</blockquote> : null}
      <dl className="details">
        <dt>Evidence ID</dt>
        <dd className="mono">{evidence.id}</dd>
        <dt>Observed</dt>
        <dd>
          <Time iso={evidence.observedAt} />
          {evidence.stale ? ' · old; not a statement about the present' : ''}
        </dd>
        <dt>Confidence</dt>
        <dd>
          <StatusBadge status={evidence.confidence} /> {evidence.rationale}
        </dd>
        {internal ? (
          <>
            <dt>Review status</dt>
            <dd>
              <StatusBadge status={evidence.verificationStatus} />
            </dd>
            <dt>Privacy class</dt>
            <dd>
              <StatusBadge status={evidence.sensitivity} context="sensitivity" />
            </dd>
          </>
        ) : null}
        <dt>Source</dt>
        <dd>
          <ul>
            {evidence.sources.map((s, i) => (
              <li key={`${s.url ?? 'manual'}-${i}`} className="break">
                {s.url ?? s.label} · <StatusBadge status={s.accessStatus} /> {s.accessDetail} · retrieved <Time iso={s.retrievedAt} />
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <Caveats caveats={evidence.caveats} />
      {internal ? <Link href={`/evidence/${runId}?ev=${evidence.id}`}>Open in evidence desk</Link> : null}
    </details>
  );
}

function Claim({ opp, view, bundle }: { opp: OpportunityView; view: ReportView; bundle: ReportBundle }) {
  const internal = view.audience === 'internal';
  const approved = bundle.report.status === 'approved_internal' || bundle.report.status === 'approved_to_share';
  const ownerSafe = bundle.ownerOpportunityIds.includes(opp.id);
  return (
    <article className="claim" aria-labelledby={`opp-${opp.id}`}>
      <h3 id={`opp-${opp.id}`}>
        {opp.title}{' '}
        {internal ? (
          <>
            <StatusBadge status={opp.status} /> {opp.decision === 'accepted' ? <Badge tone="ok">Accepted by you</Badge> : <Badge tone="warn">Awaiting your decision</Badge>}
          </>
        ) : null}
      </h3>
      <p className="claim-label">Observed fact</p>
      <p>{opp.observedFact}</p>
      {opp.evidence.map((e) => (
        <SourceDrawer key={e.id} evidence={e} runId={view.runId} internal={internal} />
      ))}
      <p className="claim-label">Why it might matter (hypothesis, not established)</p>
      <p>{opp.interpretation}</p>
      <p className="claim-label">Other explanations</p>
      <ul>
        {opp.alternatives.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="claim-label">Confidence in the observation</p>
      <p>
        <StatusBadge status={opp.confidence} /> This rates how directly the fact was observed. It is not an estimate of business impact.
      </p>
      <Caveats caveats={opp.caveats} />
      {internal ? (
        <>
          {opp.decision === 'pending' ? (
            <form action={decideOpportunityAction}>
              <input type="hidden" name="reportId" value={bundle.report.id} />
              <input type="hidden" name="opportunityId" value={opp.id} />
              <Field label="Reviewer note (required to reject)" hint="Check: right business, source, date, observed versus inferred, a counterexample, and whether the owner would find it fair.">
                <input type="text" name="reason" maxLength={300} />
              </Field>
              <div className="button-row">
                <button type="submit" name="decision" value="accepted" disabled={opp.status !== 'supported'}>
                  Accept opportunity
                </button>
                <button type="submit" name="decision" value="rejected" className="btn-danger">
                  Reject opportunity
                </button>
              </div>
              {opp.status !== 'supported' ? (
                <p className="small muted">
                  Accept becomes available once all of its evidence is accepted in the <Link href={`/evidence/${view.runId}`}>evidence desk</Link>.
                </p>
              ) : null}
            </form>
          ) : (
            <p className="small muted">Your note: {opp.decisionReason ?? 'none'}</p>
          )}
          {approved && opp.decision === 'accepted' ? (
            ownerSafe ? (
              <form action={createOutreachAction}>
                <input type="hidden" name="reportId" value={bundle.report.id} />
                <input type="hidden" name="opportunityId" value={opp.id} />
                <button type="submit">Draft outreach from this finding</button>
              </form>
            ) : (
              <p className="small muted">Outreach cannot be drafted from this finding because it relies on restricted or internal-only evidence.</p>
            )
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function Body({ view, bundle }: { view: ReportView; bundle: ReportBundle }) {
  const internal = view.audience === 'internal';
  return (
    <>
      <section className="card" aria-labelledby="exec-h">
        <h2 id="exec-h">1. Executive finding</h2>
        <p>{view.executiveFinding}</p>
        <dl className="details">
          <dt>Business</dt>
          <dd>
            {view.business.displayName}, {view.business.city}, {view.business.state}
          </dd>
          <dt>Website</dt>
          <dd className="break">{view.business.domain ?? 'None on record'}</dd>
          <dt>Identity check</dt>
          <dd>{view.business.identity}</dd>
          <dt>Investigated</dt>
          <dd>
            <Time iso={view.investigatedAt} />
          </dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="journey-h">
        <h2 id="journey-h">2. Observed customer journey</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Status</th>
                <th scope="col">What was observed</th>
              </tr>
            </thead>
            <tbody>
              {view.journey.map((j) => (
                <tr key={j.step}>
                  <td>{j.step}</td>
                  <td>
                    <Badge tone={j.state === 'Verified' ? 'ok' : j.state === 'Not checked' ? 'neutral' : j.state === 'Error' ? 'bad' : 'warn'}>{j.state}</Badge>
                  </td>
                  <td>{j.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">“Not checked”, “Checked; not found”, “Access restricted” and “Error” mean different things. Only “Checked; not found” says the pages listed were inspected and the item was not there.</p>
      </section>

      <section aria-labelledby="claims-h">
        <h2 id="claims-h">3. Evidence cards</h2>
        {view.opportunities.length === 0 ? (
          <div className="empty">
            <p className="empty-title">{internal ? 'No opportunity is currently supported by evidence.' : 'No findings are included in the owner version.'}</p>
            <p>{internal ? '“No finding” is a valid outcome. Do not stretch weak signals to fill this section.' : 'Only findings you accepted, built entirely on accepted public evidence, are included.'}</p>
          </div>
        ) : (
          view.opportunities.map((o) => <Claim key={o.id} opp={o} view={view} bundle={bundle} />)
        )}
      </section>

      <section className="card" aria-labelledby="unknown-h">
        <h2 id="unknown-h">4. Unknowns and alternative explanations</h2>
        <ul>
          {view.unknowns.map((u) => (
            <li key={u.question}>
              <strong>{u.question}</strong> {u.reason}
            </li>
          ))}
          <li>
            <strong>How calls, voicemails and requests are handled inside the business is unknown.</strong> Nothing here was tested by calling, booking or submitting a form. Only the owner can confirm it.
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="questions-h">
        <h2 id="questions-h">5. Owner questions</h2>
        {view.ownerQuestions.length === 0 ? <p className="muted">None, because no finding is included.</p> : <ul>{view.ownerQuestions.map((q) => <li key={q}>{q}</li>)}</ul>}
      </section>

      <section className="card" aria-labelledby="fix-h">
        <h2 id="fix-h">6. Possible improvements</h2>
        {view.possibleImprovements.length === 0 ? <p className="muted">None proposed. A fix is only suggested after a gap is substantiated.</p> : <ul>{view.possibleImprovements.map((p) => <li key={p}>{p}</li>)}</ul>}
        <p className="small muted">Each depends on the owner confirming the gap. The right answer may be no automation at all.</p>
      </section>

      <section className="card" aria-labelledby="method-h">
        <h2 id="method-h">7. Methodology and limitations</h2>
        <ul>
          {view.methodology.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <h3>Sources inspected ({view.sources.length})</h3>
        {view.sources.length === 0 ? (
          <p className="muted">No {internal ? '' : 'public '}source was inspected.</p>
        ) : (
          <ul>
            {view.sources.map((s, i) => (
              <li key={`${s.url ?? 'm'}-${i}`} className="break">
                {s.url ?? s.label} · <StatusBadge status={s.accessStatus} /> {s.accessDetail} · <Time iso={s.retrievedAt} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * The owner preview. It takes only the owner view, which is an allowlist, so
 * no internal field (review notes, excerpts, diagnostics, IDs) can be shown here.
 */
function OwnerBody({ view }: { view: OwnerReportView }) {
  return (
    <>
      <section className="card" aria-labelledby="exec-h">
        <h2 id="exec-h">1. Executive finding</h2>
        <p>{view.executiveFinding}</p>
        <dl className="details">
          <dt>Business</dt>
          <dd>
            {view.business.displayName}, {view.business.city}, {view.business.state}
          </dd>
          <dt>Website</dt>
          <dd className="break">{view.business.domain ?? 'None on record'}</dd>
          <dt>Identity check</dt>
          <dd>{view.business.identity}</dd>
          <dt>Investigated</dt>
          <dd>
            <Time iso={view.investigatedAt} />
          </dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="journey-h">
        <h2 id="journey-h">2. Observed customer journey</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Status</th>
                <th scope="col">What was observed</th>
              </tr>
            </thead>
            <tbody>
              {view.journey.map((j) => (
                <tr key={j.step}>
                  <td>{j.step}</td>
                  <td>
                    <Badge tone={j.state === 'Verified' ? 'ok' : j.state === 'Not checked' ? 'neutral' : j.state === 'Error' ? 'bad' : 'warn'}>{j.state}</Badge>
                  </td>
                  <td>{j.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="claims-h">
        <h2 id="claims-h">3. Findings</h2>
        {view.opportunities.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No findings are included in the owner version.</p>
            <p>Only findings you accepted, built entirely on accepted public evidence, are included.</p>
          </div>
        ) : (
          view.opportunities.map((opp, i) => (
            <article className="claim" key={`${i}-${opp.title}`}>
              <h3>{opp.title}</h3>
              <p className="claim-label">Observed fact</p>
              <p>{opp.observedFact}</p>
              {opp.evidence.map((e) => (
                <details key={e.shortId}>
                  <summary>
                    View source: <span className="mono">{e.shortId}</span> {e.observation.slice(0, 70)}
                    {e.observation.length > 70 ? '…' : ''}
                  </summary>
                  <p>{e.observation}</p>
                  <dl className="details">
                    <dt>Observed</dt>
                    <dd>
                      <Time iso={e.observedAt} />
                      {e.stale ? ' · old; not a statement about the present' : ''}
                    </dd>
                    <dt>Confidence</dt>
                    <dd>
                      <StatusBadge status={e.confidence} /> {e.rationale}
                    </dd>
                    <dt>Source</dt>
                    <dd>
                      <ul>
                        {e.sources.map((s, n) => (
                          <li key={`${s.url ?? 'none'}-${n}`} className="break">
                            {s.label}
                            {s.url ? `: ${s.url}` : ' (no link recorded)'}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </dl>
                  <Caveats caveats={e.caveats} />
                </details>
              ))}
              <p className="claim-label">Why it might matter (hypothesis, not established)</p>
              <p>{opp.interpretation}</p>
              <p className="claim-label">Other explanations</p>
              <ul>
                {opp.alternatives.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
              <p className="claim-label">Confidence in the observation</p>
              <p>
                <StatusBadge status={opp.confidence} /> This rates how directly the fact was observed. It is not an estimate of business impact.
              </p>
              <Caveats caveats={opp.caveats} />
            </article>
          ))
        )}
      </section>

      <section className="card" aria-labelledby="unknown-h">
        <h2 id="unknown-h">4. What we could not verify</h2>
        <ul>
          {view.unknowns.map((u) => (
            <li key={u.question}>
              <strong>{u.question}</strong> {u.reason}
            </li>
          ))}
          <li>
            <strong>How calls, voicemails and requests are handled inside the business is unknown.</strong> Nothing here was tested by calling, booking or submitting a form. Only the owner can confirm it.
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="questions-h">
        <h2 id="questions-h">5. Owner questions</h2>
        {view.ownerQuestions.length === 0 ? <p className="muted">None, because no finding is included.</p> : <ul>{view.ownerQuestions.map((q) => <li key={q}>{q}</li>)}</ul>}
      </section>

      <section className="card" aria-labelledby="fix-h">
        <h2 id="fix-h">6. Possible improvements</h2>
        {view.possibleImprovements.length === 0 ? <p className="muted">None proposed. A fix is only suggested after a gap is substantiated.</p> : <ul>{view.possibleImprovements.map((p) => <li key={p}>{p}</li>)}</ul>}
        <p className="small muted">Each depends on the owner confirming the gap. The right answer may be no automation at all.</p>
      </section>

      <section className="card" aria-labelledby="method-h">
        <h2 id="method-h">7. Methodology and limitations</h2>
        <ul>
          {view.methodology.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <h3>Pages of the business website ({view.sources.length})</h3>
        {view.sources.length === 0 ? (
          <p className="muted">No public source was inspected.</p>
        ) : (
          <ul>
            {view.sources.map((s, i) => (
              <li key={`${s.url}-${i}`} className="break">
                {s.url} · {s.status} · <Time iso={s.retrievedAt} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string; n?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { view: viewParam, n } = await searchParams;
  let bundle: ReportBundle;
  try {
    bundle = getReportBundle(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') notFound();
    throw e;
  }
  const { report, business, run } = bundle;
  const ownerPreview = viewParam === 'owner';
  const approved = report.status === 'approved_internal' || report.status === 'approved_to_share';
  const base = `/reports/${report.id}`;

  return (
    <>
      <PageHeader
        crumbs={[{ href: '/', label: 'Home' }, { href: '/reports', label: 'Reports' }, { label: business.displayName }]}
        title={`Opportunity report: ${business.displayName}`}
        badges={
          <>
            <StatusBadge status={report.status} /> {business.synthetic ? <MockBadge /> : null}
          </>
        }
        subtitle={ownerPreview ? 'Owner preview: exactly what the owner would see. Restricted evidence and internal notes are removed.' : `Internal view, version ${report.version}. Every claim links to its source.`}
        actions={
          ownerPreview ? (
            <Link className="btn-link" href={base}>
              Back to internal view
            </Link>
          ) : (
            <Link className="btn-link" href={`${base}?view=owner`}>
              Preview as owner
            </Link>
          )
        }
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />

      {business.synthetic ? (
        <div className="callout">
          <strong>MOCK DATA.</strong> This report is about a fictional business built from synthetic fixtures. Never present it as research about a real company.
        </div>
      ) : null}
      {run.status === 'partial' ? (
        <div className="callout callout-warn">
          The investigation was partial. Sources that were restricted, failed or not checked are listed as unknowns, not findings. <Link href={`/investigations/${run.id}`}>See the investigation</Link>
        </div>
      ) : null}

      {!ownerPreview ? (
        <>
          {!approved ? <div className="watermark">INTERNAL · NOT APPROVED · DO NOT SHARE</div> : report.status === 'approved_internal' ? <div className="watermark">INTERNAL · APPROVED FOR INTERNAL USE ONLY</div> : null}
          <Body view={bundle.internal} bundle={bundle} />
          <section className="card" aria-labelledby="approve-h">
            <h2 id="approve-h">Approve report</h2>
            {approved ? (
              <>
                <p>
                  Approved for internal use on <Time iso={report.approvedAt} />. This does not mean the business agreed with anything in it, and it has not been shared. If evidence changes, the approval is withdrawn automatically.
                </p>
                <div className="button-row">
                  <Link className="btn-link btn-primary" href={`${base}?view=owner`}>
                    Preview as owner
                  </Link>
                  <Link className="btn-link" href="/outreach">
                    Go to outreach
                  </Link>
                </div>
              </>
            ) : bundle.blockers.length > 0 ? (
              <>
                <p>The report cannot be approved yet:</p>
                <ul>
                  {bundle.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                <Link className="btn-link btn-primary" href={`/evidence/${run.id}?f=needs_review`}>
                  Go to evidence review
                </Link>
              </>
            ) : (
              <form action={approveReportAction}>
                <input type="hidden" name="reportId" value={report.id} />
                <input type="hidden" name="hash" value={bundle.internalHash} />
                <p>Approving means you have checked every claim above against its source. It approves this exact content for internal use. It does not share the report and does not approve any outreach.</p>
                <button type="submit" className="btn-primary">
                  Approve report
                </button>
              </form>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="card" aria-labelledby="redact-h">
            <h2 id="redact-h">Redaction summary (you see this; the owner does not)</h2>
            <dl className="details">
              <dt>Findings included</dt>
              <dd>{bundle.redaction.opportunitiesIncluded}</dd>
              <dt>Findings withheld</dt>
              <dd>
                {bundle.redaction.opportunitiesWithheld.length === 0 ? (
                  'None'
                ) : (
                  <ul>
                    {bundle.redaction.opportunitiesWithheld.map((w) => (
                      <li key={w.title}>
                        <strong>{w.title}:</strong> {w.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt>Observations withheld</dt>
              <dd>{bundle.redaction.evidenceWithheld} (restricted, personal, unreviewed, rejected, or not confirmed to be about this business)</dd>
              <dt>Sources withheld</dt>
              <dd>{bundle.redaction.sourcesWithheld} (manual research notes, and any page not on the business&apos;s own website, are never listed in the owner version)</dd>
              <dt>Unknowns withheld</dt>
              <dd>{bundle.redaction.unknownsWithheld} (kept internal because they are not in a form known to be safe to share)</dd>
              <dt>Third-party observations included</dt>
              <dd>
                {bundle.redaction.thirdPartyObservationsIncluded === 0
                  ? 'None'
                  : `${bundle.redaction.thirdPartyObservationsIncluded}. These paraphrase a public page that is not the business's own. Check that site's terms before you share this.`}
              </dd>
            </dl>
            <p className="small muted">The owner version fails closed: anything not positively classified as public and accepted is left out, and a finding that rests on any withheld evidence is left out entirely.</p>
          </section>

          <OwnerBody view={bundle.owner} />

          <section className="card" aria-labelledby="exact-h">
            <h2 id="exact-h">Exact text of the owner version</h2>
            <p className="muted">This Markdown is what would be exported, character for character.</p>
            <pre className="export" tabIndex={0}>
              {report.status === 'approved_to_share' && report.sharedSnapshot ? report.sharedSnapshot : bundle.ownerMarkdown}
            </pre>
            {report.status === 'approved_to_share' ? (
              <>
                <p>
                  Owner version approved on <Time iso={report.sharedAt} />. Nothing has been sent. Downloading is recorded in the audit log.
                </p>
                <a className="btn-link btn-primary" href={`/api/reports/${report.id}/export`}>
                  Download owner version (.md)
                </a>
              </>
            ) : report.status === 'approved_internal' ? (
              <form action={approveShareAction}>
                <input type="hidden" name="reportId" value={report.id} />
                <input type="hidden" name="hash" value={bundle.ownerHash} />
                <p>Approving the owner version approves this exact text for you to share yourself. The app does not send or publish it, and this is separate from approving outreach.</p>
                <button type="submit" className="btn-primary">
                  Approve owner version
                </button>
              </form>
            ) : (
              <p>
                Approve the internal report first. <Link href={base}>Back to internal view</Link>
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
