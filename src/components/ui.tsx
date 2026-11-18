import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Notice } from '@/lib/types';

/** One consistent, unambiguous timestamp format everywhere: UTC, stated. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return 'not yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span>not yet</span>;
  return <time dateTime={iso}>{fmtTime(iso)}</time>;
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'mock';

/** Status is always written out in words; color is only a second cue. */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function MockBadge() {
  return <Badge tone="mock">MOCK · synthetic</Badge>;
}

const STATUS_WORDS: Record<string, { label: string; tone: Tone }> = {
  // stages
  pending: { label: 'Pending', tone: 'neutral' },
  running: { label: 'In progress', tone: 'info' },
  complete: { label: 'Complete', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  restricted: { label: 'Access restricted', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  not_checked: { label: 'Not checked', tone: 'neutral' },
  // runs
  queued: { label: 'Queued', tone: 'neutral' },
  resolving_identity: { label: 'Checking identity', tone: 'info' },
  collecting: { label: 'Collecting', tone: 'info' },
  analyzing: { label: 'Analyzing', tone: 'info' },
  verifying: { label: 'Verifying', tone: 'info' },
  review_ready: { label: 'Ready for review', tone: 'ok' },
  blocked: { label: 'Blocked: needs you', tone: 'warn' },
  canceled: { label: 'Stopped', tone: 'neutral' },
  // sources
  ok: { label: 'Checked', tone: 'ok' },
  unavailable: { label: 'Error: unavailable', tone: 'bad' },
  error: { label: 'Error', tone: 'bad' },
  // evidence
  needs_review: { label: 'Needs review', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  needs_verification: { label: 'Needs verification', tone: 'warn' },
  // opportunities
  supported: { label: 'Evidence accepted', tone: 'ok' },
  invalidated: { label: 'No longer supported', tone: 'bad' },
  // reports
  draft: { label: 'Draft', tone: 'neutral' },
  evidence_review: { label: 'In evidence review', tone: 'warn' },
  approved_internal: { label: 'Approved (internal)', tone: 'ok' },
  approved_to_share: { label: 'Owner version approved', tone: 'ok' },
  // outreach
  approved: { label: 'Approved (not sent)', tone: 'ok' },
  sent_manual: { label: 'Sent by you', tone: 'ok' },
  // misc
  low: { label: 'Low confidence', tone: 'neutral' },
  medium: { label: 'Medium confidence', tone: 'neutral' },
  high: { label: 'High confidence', tone: 'neutral' },
  public: { label: 'Public', tone: 'neutral' },
  personal: { label: 'Personal: internal only', tone: 'warn' },
};

export function StatusBadge({ status, context }: { status: string; context?: 'sensitivity' }) {
  if (context === 'sensitivity' && status === 'restricted') return <Badge tone="warn">Restricted: internal only</Badge>;
  const known = STATUS_WORDS[status];
  return <Badge tone={known?.tone ?? 'neutral'}>{known?.label ?? status}</Badge>;
}

export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <strong>{notice.kind === 'error' ? 'Not done. ' : 'Done. '}</strong>
      {notice.text}
    </div>
  );
}

export type Crumb = { href?: string; label: string };

export function PageHeader({ crumbs, title, subtitle, badges, actions }: { crumbs: Crumb[]; title: string; subtitle?: string; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <ol>
          {crumbs.map((c, i) => (
            <li key={`${c.label}-${i}`}>{c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}</li>
          ))}
        </ol>
      </nav>
      <div className="page-title-row">
        <div>
          <h1>
            {title} {badges}
          </h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

const CAVEAT_WORDS: Record<string, string> = {
  geo_uncertain: 'No search location recorded',
  anecdotal: 'Single account, not a pattern',
  stale: 'Older than the freshness window',
  html_only: 'HTML only; JavaScript content not seen',
  site_may_be_outdated: 'Site may be outdated',
};

export function Caveats({ caveats }: { caveats: string[] }) {
  if (caveats.length === 0) return null;
  return (
    <ul className="caveats" aria-label="Caveats">
      {caveats.map((c) => (
        <li key={c}>
          <Badge tone="warn">{CAVEAT_WORDS[c] ?? c}</Badge>
        </li>
      ))}
    </ul>
  );
}
