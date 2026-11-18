import Link from 'next/link';
import { notFound } from 'next/navigation';
import { addManualEvidenceAction, reviewEvidenceAction } from '../../actions';
import { Badge, Caveats, Empty, Field, MockBadge, NoticeBanner, PageHeader, StatusBadge, Time } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { isAppError } from '@/lib/errors';
import { shortId } from '@/lib/ids';
import { requireCtx } from '@/lib/runtime';
import { getBusiness } from '@/lib/services/businesses';
import { getEvidenceDesk, type EvidenceDeskItem } from '@/lib/services/evidence';
import { getRunDetail } from '@/lib/services/investigations';

const FILTERS: { key: string; label: string; test: (i: EvidenceDeskItem) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'needs_review', label: 'Needs review', test: (i) => i.evidence.verificationStatus === 'needs_review' || i.evidence.verificationStatus === 'needs_verification' },
  { key: 'verified', label: 'Verified', test: (i) => i.evidence.verificationStatus === 'accepted' },
  { key: 'restricted', label: 'Restricted', test: (i) => i.evidence.sensitivity !== 'public' },
  { key: 'contradictory', label: 'Contradictory', test: (i) => i.contradictory },
  { key: 'rejected', label: 'Rejected', test: (i) => i.evidence.verificationStatus === 'rejected' },
];

const TYPE_WORDS: Record<string, string> = {
  phone_listed: 'Website: phone number',
  contact_form: 'Website: contact form',
  booking_link: 'Website: booking link',
  after_hours_statement: 'Website: states after-hours availability',
  after_hours_negative: 'Website: says after-hours or emergency service is not offered',
  after_hours_mention: 'Website: mentions emergency service, availability not stated',
  phone_scheduling_statement: 'Website: phone scheduling',
  hours_listed: 'Website: published hours',
  hours_conflict: 'Website: published hours disagree',
  stale_marker: 'Website: age marker',
  instruction_like_text: 'Website: instruction-like text (ignored)',
  customer_comment: 'Manual: customer comment',
  owner_statement: 'Manual: owner statement',
  search_observation: 'Manual: search observation',
  operator_observation: 'Manual: your own observation',
};

const IDENTITY_WORDS: Record<string, string> = {
  confirmed: 'Confirmed to be about this business',
  uncertain: 'Not confirmed to be about this business',
  mismatch: 'About a different business; cannot be used',
};

export default async function EvidenceDeskPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Promise<{ ev?: string; f?: string; n?: string }> }) {
  const ctx = await requireCtx();
  const { runId } = await params;
  const { ev, f, n } = await searchParams;
  let desk: ReturnType<typeof getEvidenceDesk>;
  try {
    desk = getEvidenceDesk(ctx, runId);
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') notFound();
    throw e;
  }
  const business = getBusiness(ctx, desk.run.businessId);
  const detail = getRunDetail(ctx, runId);
  const filter = FILTERS.find((x) => x.key === f) ?? FILTERS[0]!;
  const visible = desk.items.filter(filter.test);
  const selected = desk.items.find((i) => i.evidence.id === ev) ?? visible[0] ?? null;
  const q = (id: string) => `/evidence/${runId}?ev=${id}${filter.key !== 'all' ? `&f=${filter.key}` : ''}`;
  const pending = desk.items.filter((i) => i.evidence.verificationStatus === 'needs_review').length;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        crumbs={[{ href: '/', label: 'Home' }, { href: '/evidence', label: 'Evidence' }, { label: business.displayName }]}
        title="What we actually found"
        badges={business.synthetic ? <MockBadge /> : null}
        subtitle={`${business.displayName}: ${desk.items.length} observation(s), ${pending} waiting for your decision. Accept what you would stake your reputation on; reject the rest.`}
        actions={
          detail.reportId ? (
            <Link className={`btn-link ${pending === 0 ? 'btn-primary' : ''}`} href={`/reports/${detail.reportId}`}>
              {pending === 0 ? 'Continue to report' : 'Open report'}
            </Link>
          ) : undefined
        }
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />

      {detail.run.status === 'partial' ? (
        <div className="callout callout-warn">
          This investigation is partial: some sources were restricted, failed, or were not checked. Missing sources are not evidence of anything. <Link href={`/investigations/${runId}`}>See which sources</Link>
        </div>
      ) : null}

      <nav aria-label="Filter observations">
        <ul className="filters">
          {FILTERS.map((x) => (
            <li key={x.key}>
              <Link href={`/evidence/${runId}${x.key !== 'all' ? `?f=${x.key}` : ''}`} aria-current={x.key === filter.key ? 'true' : undefined}>
                {x.label} ({desk.items.filter(x.test).length})
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {desk.items.length === 0 ? (
        <Empty title="No observations were recorded for this investigation.">
          <p>That is not the same as “nothing is wrong”: it means no source produced an observation. Check the investigation’s sources, or record what you saw yourself below.</p>
        </Empty>
      ) : (
        <div className="desk">
          <section aria-labelledby="obs-h">
            <h2 id="obs-h">Observations</h2>
            {visible.length === 0 ? (
              <p className="muted">No observations match “{filter.label}”.</p>
            ) : (
              <ul className="obs-list">
                {visible.map((item) => (
                  <li key={item.evidence.id}>
                    <Link className="obs-link" href={q(item.evidence.id)} aria-current={selected?.evidence.id === item.evidence.id ? 'true' : undefined}>
                      <span className="small muted">
                        {TYPE_WORDS[item.evidence.evidenceType]} · <span className="mono">{shortId(item.evidence.id)}</span>
                      </span>
                      <br />
                      {item.evidence.observation}
                      <span className="obs-meta">
                        <StatusBadge status={item.evidence.verificationStatus} />
                        {item.evidence.sensitivity !== 'public' ? <StatusBadge status={item.evidence.sensitivity} context="sensitivity" /> : null}
                        {item.contradictory ? <Badge tone="warn">Contradicted by another observation</Badge> : null}
                        {item.evidence.identityMatchStatus !== 'confirmed' ? <Badge tone="bad">Identity not confirmed</Badge> : null}
                        {item.stale ? <Badge tone="warn">Old</Badge> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="src-h">
            <h2 id="src-h">Source details</h2>
            {!selected ? (
              <p className="muted">Select an observation to see where it came from.</p>
            ) : (
              <>
                <p className="claim-label">Exact observed fact</p>
                <p>{selected.evidence.observation}</p>
                {selected.evidence.supportingExcerpt ? (
                  <>
                    <p className="claim-label">Excerpt from the source (untrusted text, shown as plain text)</p>
                    <blockquote className="excerpt">{selected.evidence.supportingExcerpt}</blockquote>
                  </>
                ) : null}
                {selected.contradictory ? <div className="callout callout-warn">Another observation on the same topic says the opposite. Both stay visible; neither can be presented as a pattern.</div> : null}
                <dl className="details">
                  <dt>Evidence ID</dt>
                  <dd className="mono">{selected.evidence.id}</dd>
                  <dt>Kind</dt>
                  <dd>{TYPE_WORDS[selected.evidence.evidenceType]}</dd>
                  <dt>Observed</dt>
                  <dd>
                    <Time iso={selected.evidence.observedAt} />
                    {selected.stale ? ' · older than the freshness window; must not be described as current' : ''}
                  </dd>
                  <dt>Business match</dt>
                  <dd>{IDENTITY_WORDS[selected.evidence.identityMatchStatus]}</dd>
                  <dt>Privacy class</dt>
                  <dd>
                    <StatusBadge status={selected.evidence.sensitivity} context="sensitivity" /> {selected.evidence.sensitivity === 'public' ? 'May appear in an owner report once accepted.' : 'Never appears in an owner report or export.'}
                  </dd>
                  <dt>Confidence</dt>
                  <dd>
                    <StatusBadge status={selected.evidence.confidence} /> {selected.evidence.confidenceRationale} Confidence is about the observation, not about business impact.
                  </dd>
                  <dt>Review status</dt>
                  <dd>
                    <StatusBadge status={selected.evidence.verificationStatus} />
                    {selected.evidence.reviewNote ? ` Reviewer note: ${selected.evidence.reviewNote}` : ''}
                  </dd>
                  {selected.evidence.synthetic ? (
                    <>
                      <dt>Data origin</dt>
                      <dd>
                        <MockBadge /> Fictional fixture, not a real observation.
                      </dd>
                    </>
                  ) : null}
                </dl>
                <Caveats caveats={selected.evidence.caveats} />

                <h3>Sources ({selected.sources.length})</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Original URL</th>
                        <th scope="col">Access</th>
                        <th scope="col">Retrieved</th>
                        <th scope="col">Storage class</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.sources.map((s) => (
                        <tr key={s.id}>
                          <td className="break">
                            {s.sourceUrl ? (
                              s.synthetic ? (
                                <span>{s.sourceUrl} (synthetic address; does not exist)</span>
                              ) : (
                                <a href={s.sourceUrl} rel="noreferrer noopener" target="_blank">
                                  {s.sourceUrl}
                                </a>
                              )
                            ) : (
                              'No shareable link (manual observation)'
                            )}
                          </td>
                          <td>
                            <StatusBadge status={s.accessStatus} /> <span className="small">{s.accessDetail}</span>
                          </td>
                          <td>
                            <Time iso={s.retrievedAt} />
                          </td>
                          <td>{s.permittedStorageClass}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <h3>Your decision</h3>
                <form action={reviewEvidenceAction}>
                  <input type="hidden" name="runId" value={runId} />
                  <input type="hidden" name="evidenceId" value={selected.evidence.id} />
                  <input type="hidden" name="filter" value={filter.key === 'all' ? '' : filter.key} />
                  <Field label="Note (required to reject or to ask for verification)" hint="Saved with your decision in the audit log.">
                    <input type="text" name="note" maxLength={300} defaultValue="" />
                  </Field>
                  <div className="button-row">
                    <button type="submit" name="decision" value="accepted" className="btn-primary" disabled={selected.evidence.identityMatchStatus === 'mismatch'}>
                      Accept
                    </button>
                    <button type="submit" name="decision" value="rejected" className="btn-danger">
                      Reject
                    </button>
                    <button type="submit" name="decision" value="needs_verification">
                      Needs verification
                    </button>
                  </div>
                  {selected.evidence.identityMatchStatus === 'mismatch' ? <p className="small muted">Accept is unavailable: this observation is recorded as being about a different business.</p> : null}
                </form>
              </>
            )}
          </section>
        </div>
      )}

      <section className="card" aria-labelledby="manual-h">
        <h2 id="manual-h">Record something you observed yourself</h2>
        <p className="muted">
          For example, a public comment you read, or something an owner told you. Paraphrase briefly; do not paste whole posts, names, usernames or contact details. Content from login-gated or private spaces is always kept internal.
        </p>
        <details>
          <summary>Add a manual observation</summary>
          <form action={addManualEvidenceAction}>
            <input type="hidden" name="runId" value={runId} />
            <Field label="What was observed (10 to 500 characters, paraphrased)">
              <textarea name="observation" required minLength={10} maxLength={500} />
            </Field>
            <div className="form-grid">
              <Field label="Kind">
                <select name="kind" required defaultValue="customer_comment">
                  <option value="customer_comment">Customer comment</option>
                  <option value="owner_statement">Owner statement</option>
                  <option value="search_observation">Search result I saw</option>
                  <option value="operator_observation">Something I saw directly</option>
                </select>
              </Field>
              <Field label="Date observed">
                <input type="date" name="observedAt" required max={today} />
              </Field>
              <Field label="Source link" hint="Required for public pages so the claim can be checked.">
                <input type="url" name="sourceUrl" maxLength={500} placeholder="https://" />
              </Field>
              <Field label="Where the source lives">
                <select name="sourceAccess" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="public_page">Public page, no login</option>
                  <option value="login_required">Login required</option>
                  <option value="private_group">Private or members-only group</option>
                </select>
              </Field>
              <Field label="Privacy class" hint="Gated sources are stored as restricted whatever you choose.">
                <select name="sensitivity" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="public">Public: may be shown to the owner</option>
                  <option value="restricted">Restricted: internal only</option>
                  <option value="personal">Personal: internal only</option>
                </select>
              </Field>
              <Field label="Is it about this business?">
                <select name="identityMatch" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="confirmed">Yes, confirmed</option>
                  <option value="uncertain">Not sure</option>
                  <option value="mismatch">No, a different business</option>
                </select>
              </Field>
              <Field label="Topic">
                <select name="topic" required defaultValue="callback">
                  <option value="callback">Callbacks and follow-up</option>
                  <option value="booking">Booking</option>
                  <option value="contact">Contact</option>
                  <option value="punctuality">Punctuality</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="What it reports">
                <select name="stance" required defaultValue="reports_problem">
                  <option value="reports_problem">A problem</option>
                  <option value="reports_positive">A good experience</option>
                  <option value="neutral">Neither</option>
                </select>
              </Field>
              <Field label="Search query (search results only)">
                <input type="text" name="query" maxLength={200} />
              </Field>
              <Field label="Search location (search results only)" hint="Without a location the observation is marked geo-uncertain.">
                <input type="text" name="queryLocation" maxLength={100} />
              </Field>
            </div>
            <button type="submit">Record observation</button>
          </form>
        </details>
        {desk.superseded > 0 ? <p className="small muted">{desk.superseded} earlier observation(s) were replaced after more pages were inspected. They are kept in storage and hidden here.</p> : null}
        <p className="small">
          <Link href="/settings#audit">View the audit trail</Link> for every review decision.
        </p>
      </section>
    </>
  );
}
