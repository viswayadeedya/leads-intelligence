import Link from 'next/link';
import { approveOutreachAction, markSentAction, saveOutreachAction } from '../actions';
import { CopyButton } from '@/components/CopyButton';
import { Empty, Field, MockBadge, NoticeBanner, PageHeader, StatusBadge, Time } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { requireCtx } from '@/lib/runtime';
import { listOutreach } from '@/lib/services/outreach';

export default async function OutreachPage({ searchParams }: { searchParams: Promise<{ d?: string; n?: string }> }) {
  const ctx = await requireCtx();
  const { d, n } = await searchParams;
  const items = listOutreach(ctx);
  const ordered = d ? [...items.filter((i) => i.draft.id === d), ...items.filter((i) => i.draft.id !== d)] : items;
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/', label: 'Home' }, { label: 'Outreach' }]}
        title="Start a relevant conversation"
        subtitle="Drafts only. This app cannot send email, submit forms, post or call. You copy the text and send it yourself."
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />
      {ordered.length === 0 ? (
        <Empty title="No outreach drafts yet.">
          <p>
            A draft is created from one accepted finding in an approved report. Open a <Link href="/reports">report</Link>, approve it, then choose “Draft outreach from this finding”.
          </p>
        </Empty>
      ) : (
        ordered.map(({ draft, business, report, contentHash, recipient, observation, reportCurrent }) => {
          const sent = draft.status === 'sent_manual';
          return (
            <section className="card" key={draft.id} aria-labelledby={`d-${draft.id}`}>
              <h2 id={`d-${draft.id}`}>
                {business.displayName} <StatusBadge status={draft.status} /> {business.synthetic ? <MockBadge /> : null}
              </h2>
              {business.synthetic ? <div className="callout callout-warn">This business is fictional. The draft exists to show the workflow and can never be recorded as sent.</div> : null}
              {!reportCurrent && !sent ? (
                <div className="callout callout-warn">
                  The report changed or is no longer approved, so this draft cannot be approved. <Link href={`/reports/${report.id}`}>Review the report</Link>, then check the draft still matches it.
                </div>
              ) : null}

              <h3>Recipient and identity</h3>
              <dl className="details">
                <dt>Business</dt>
                <dd>{recipient}</dd>
                <dt>Identity check</dt>
                <dd>{business.identityStatus === 'confirmed' ? 'Name and location matched the website' : business.identityStatus === 'confirmed_by_operator' ? 'Confirmed manually by you' : 'Not verified. Confirm you have the right business before sending anything.'}</dd>
                <dt>Contact address</dt>
                <dd>Not collected. Find the business’s published contact channel yourself; this tool does not look up or store personal contact details.</dd>
                <dt>Send method</dt>
                <dd>Manual. Copy the text into your own email. Nothing is sent from here.</dd>
              </dl>

              <h3>The one observation this draft rests on</h3>
              <p>{observation ?? 'The finding is no longer available.'}</p>
              <p className="small">
                <Link href={`/reports/${report.id}`}>Open the report and its sources</Link>
              </p>

              <h3>Draft</h3>
              <form action={saveOutreachAction}>
                <input type="hidden" name="draftId" value={draft.id} />
                <Field label="Subject">
                  <input type="text" name="subject" defaultValue={draft.subject} maxLength={150} required readOnly={sent} />
                </Field>
                <Field label="Message" hint="Mention only what was observed. Figures, loss claims, guarantees, urgency and client-result claims are refused when you save.">
                  <textarea name="body" defaultValue={draft.body} rows={14} maxLength={4000} required readOnly={sent} />
                </Field>
                {!sent ? <button type="submit">Save draft</button> : null}
              </form>

              <div className="button-row">
                <CopyButton draftId={draft.id} text={`Subject: ${draft.subject}\n\n${draft.body}`} />
              </div>

              {!sent ? (
                <>
                  <h3>Approval</h3>
                  {draft.status === 'draft' ? (
                    <form action={approveOutreachAction}>
                      <input type="hidden" name="draftId" value={draft.id} />
                      <input type="hidden" name="hash" value={contentHash} />
                      <p>Approving covers the exact saved text above, for this business only, and expires after {ctx.config.approvalTtlMinutes} minutes. Save any edits first. Approval sends nothing.</p>
                      <button type="submit" className="btn-primary" disabled={!reportCurrent}>
                        Approve this exact text
                      </button>
                    </form>
                  ) : (
                    <form action={markSentAction}>
                      <input type="hidden" name="draftId" value={draft.id} />
                      <p>
                        Approved on <Time iso={draft.approvedAt} />. After you have sent it yourself, record that here. Editing the draft withdraws the approval.
                      </p>
                      <button type="submit" disabled={business.synthetic}>
                        Mark manually sent
                      </button>
                      {business.synthetic ? <p className="small muted">Unavailable for fictional businesses.</p> : null}
                    </form>
                  )}
                </>
              ) : (
                <p>
                  Recorded as sent by you on <Time iso={draft.sentAt} />. One reply would not show that the research caused it; track outcomes over a meaningful number of approaches.
                </p>
              )}
              <p className="small muted">
                Created <Time iso={draft.createdAt} /> · last copied {draft.copiedAt ? <Time iso={draft.copiedAt} /> : 'never'} · based on report version {draft.reportVersion}
              </p>
            </section>
          );
        })
      )}
    </>
  );
}
