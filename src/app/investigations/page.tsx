import Link from 'next/link';
import { Empty, MockBadge, NoticeBanner, PageHeader, StatusBadge, Time } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { requireCtx } from '@/lib/runtime';
import { listRuns } from '@/lib/services/investigations';

export default async function InvestigationsPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const ctx = await requireCtx();
  const { n } = await searchParams;
  const runs = listRuns(ctx);
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/', label: 'Home' }, { label: 'Investigations' }]}
        title="Investigations"
        subtitle="Every run, newest first, with what it cost and whether anything failed."
        actions={
          <Link className="btn-link btn-primary" href="/discover">
            Start investigation
          </Link>
        }
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />
      {runs.length === 0 ? (
        <Empty title="No investigations yet.">
          <p>Start with a business name or website, or run a synthetic example.</p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Requests</th>
                <th scope="col">Spend</th>
                <th scope="col">Problems</th>
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
                    {run.requestsUsed} of {run.requestCap}
                  </td>
                  <td>
                    {run.spentCents} of {run.budgetCents} cents
                  </td>
                  <td>{run.errorSummary.length === 0 ? <span className="muted">None recorded</span> : `${run.errorSummary.length} recorded`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
