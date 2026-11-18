import Link from 'next/link';
import { Empty, NoticeBanner, PageHeader, StatusBadge, Time, MockBadge } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { requireCtx } from '@/lib/runtime';
import { listRuns } from '@/lib/services/investigations';
import { getHomeCounts } from '@/lib/services/overview';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const ctx = await requireCtx();
  const { n } = await searchParams;
  const counts = getHomeCounts(ctx);
  const runs = listRuns(ctx).slice(0, 8);
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home' }]}
        title="Find a business worth helping"
        subtitle="Investigate real customer friction before pitching solutions."
        actions={
          <>
            <Link className="btn-link btn-primary" href="/discover">
              Start investigation
            </Link>
            <Link className="btn-link" href="/evidence">
              Review findings
            </Link>
          </>
        }
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />

      <div className="grid-4">
        <div className="stat">
          <div className="stat-value">{counts.investigated}</div>
          <div className="stat-label">Investigated (finished fully or partially)</div>
        </div>
        <div className="stat">
          <div className="stat-value">{counts.evidenceBacked}</div>
          <div className="stat-label">Evidence-backed opportunities you accepted</div>
        </div>
        <div className="stat">
          <div className="stat-value">{counts.awaitingReview}</div>
          <div className="stat-label">Observations awaiting your review</div>
        </div>
        <div className="stat">
          <div className="stat-value">Not tracked</div>
          <div className="stat-label">Owner responses. Outcome tracking is not built yet.</div>
        </div>
      </div>

      {counts.blockedRuns > 0 ? (
        <div className="callout callout-warn">
          {counts.blockedRuns} investigation(s) are blocked and need a decision from you (business identity or a possible duplicate). <Link href="/investigations">Open investigations</Link>
        </div>
      ) : null}

      <h2>Recent investigations</h2>
      {runs.length === 0 ? (
        <Empty title="No investigations yet — start with a business name or website.">
          <p>In mock mode you can run a complete example in one click from the synthetic examples.</p>
          <Link className="btn-link" href="/discover#examples-h">
            See the synthetic examples
          </Link>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Next step</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(({ run, business }) => (
                <tr key={run.id}>
                  <td className="break">
                    <Link href={`/investigations/${run.id}`}>{business.displayName}</Link> {business.synthetic ? <MockBadge /> : null}
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>
                    <Time iso={run.startedAt} />
                  </td>
                  <td>
                    {run.status === 'blocked' ? (
                      <Link href={`/investigations/${run.id}`}>Resolve what is blocking it</Link>
                    ) : run.status === 'review_ready' || run.status === 'partial' ? (
                      <Link href={`/evidence/${run.id}`}>Review evidence</Link>
                    ) : (
                      <Link href={`/investigations/${run.id}`}>Open</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
