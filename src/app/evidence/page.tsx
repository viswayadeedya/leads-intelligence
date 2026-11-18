import Link from 'next/link';
import { Empty, MockBadge, NoticeBanner, PageHeader, StatusBadge } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { requireCtx } from '@/lib/runtime';
import { getRunDetail, listRuns } from '@/lib/services/investigations';

export default async function EvidenceIndexPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const ctx = await requireCtx();
  const { n } = await searchParams;
  const rows = listRuns(ctx).map(({ run }) => getRunDetail(ctx, run.id));
  return (
    <>
      <PageHeader crumbs={[{ href: '/', label: 'Home' }, { label: 'Evidence' }]} title="What we actually found" subtitle="Choose an investigation to review its observations. Nothing reaches a report as fact until you accept it." />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />
      {rows.length === 0 ? (
        <Empty title="No evidence yet.">
          <p>
            Evidence appears after an investigation runs. <Link href="/discover">Start an investigation</Link>.
          </p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Run status</th>
                <th scope="col">Needs review</th>
                <th scope="col">Accepted</th>
                <th scope="col">Rejected</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.run.id}>
                  <td className="break">
                    {d.business.displayName} {d.business.synthetic ? <MockBadge /> : null}
                  </td>
                  <td>
                    <StatusBadge status={d.run.status} />
                  </td>
                  <td>{d.evidenceCounts.needsReview}</td>
                  <td>{d.evidenceCounts.accepted}</td>
                  <td>{d.evidenceCounts.rejected}</td>
                  <td>
                    <Link href={`/evidence/${d.run.id}`}>{d.evidenceCounts.total === 0 ? 'Open (no observations)' : 'Review evidence'}</Link>
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
