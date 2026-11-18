import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { requireCtx } from '@/lib/runtime';
import { listOutreach } from '@/lib/services/outreach';

export default async function OutcomesPage() {
  const ctx = await requireCtx();
  const sent = listOutreach(ctx).filter((i) => i.draft.status === 'sent_manual').length;
  return (
    <>
      <PageHeader crumbs={[{ href: '/', label: 'Home' }, { label: 'Outcomes' }]} title="Did our research create a conversation?" subtitle="Outcome tracking is planned and not built yet. Nothing on this page is measured." />
      <div className="empty">
        <p className="empty-title">Not built yet.</p>
        <p>
          The plan is manual entry of what happened after each approach (responded, diagnostic requested, meeting, pilot, paid client, no response), always shown with its denominator and time window. It is scheduled after the investigation workflow has been used on real businesses.
        </p>
        <p>
          What exists today: {sent} outreach draft(s) recorded as sent by you. See <Link href="/outreach">Outreach</Link>. No replies, meetings or revenue are tracked, and none should be inferred.
        </p>
      </div>
    </>
  );
}
