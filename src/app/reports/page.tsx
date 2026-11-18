import Link from 'next/link';
import { Empty, MockBadge, NoticeBanner, PageHeader, StatusBadge, Time } from '@/components/ui';
import { readNotice } from '@/lib/auth';
import { requireCtx } from '@/lib/runtime';
import { listReports } from '@/lib/services/reports';

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const ctx = await requireCtx();
  const { n } = await searchParams;
  const reports = listReports(ctx);
  return (
    <>
      <PageHeader crumbs={[{ href: '/', label: 'Home' }, { label: 'Reports' }]} title="Reports" subtitle="All reports are private. A report is internal until you approve it, and the owner version needs its own separate approval." />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />
      {reports.length === 0 ? (
        <Empty title="No reports yet.">
          <p>
            A report is created when an investigation finishes. <Link href="/discover">Start an investigation</Link>.
          </p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Report status</th>
                <th scope="col">Version</th>
                <th scope="col">Investigation</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {reports.map(({ report, business, run }) => (
                <tr key={report.id}>
                  <td className="break">
                    <Link href={`/reports/${report.id}`}>{business.displayName}</Link> {business.synthetic ? <MockBadge /> : null}
                  </td>
                  <td>
                    <StatusBadge status={report.status} />
                  </td>
                  <td>{report.version}</td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>
                    <Time iso={report.createdAt} />
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
