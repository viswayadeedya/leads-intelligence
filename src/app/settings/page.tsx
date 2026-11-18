import { Badge, PageHeader, Time } from '@/components/ui';
import { requireCtx } from '@/lib/runtime';
import { listAudit } from '@/lib/services/overview';

export default async function SettingsPage() {
  const ctx = await requireCtx();
  const c = ctx.config;
  const audit = listAudit(ctx, 100);
  return (
    <>
      <PageHeader crumbs={[{ href: '/', label: 'Home' }, { label: 'Settings' }]} title="Control sources, cost and privacy" subtitle="Read-only in this build. Values come from environment variables; secrets are never displayed." />

      <div className="grid-2">
        <section className="card" aria-labelledby="mode-h">
          <h2 id="mode-h">Mode</h2>
          <p>
            <Badge tone="mock">MOCK</Badge> Website checks read bundled synthetic fixtures. No external request is made and no paid API is called.
          </p>
          <p>
            <Badge tone="neutral">Live mode: unavailable</Badge> Live mode cannot be switched on in this build. It requires the release gates in the security protocol (database row-level security tests, egress restrictions, retention policy, independent review) and a deliberate confirmation from you.
          </p>
          {c.liveRequested ? <p className="notice notice-error">The environment requests live mode. That request is ignored; the app is running in mock mode.</p> : null}
        </section>

        <section className="card" aria-labelledby="cred-h">
          <h2 id="cred-h">API credential health</h2>
          <p className="muted small">Shows only whether a value is present. Values are never read into the page, logs or browser.</p>
          <ul>
            {c.credentials.map((cred) => (
              <li key={cred.name}>
                <span className="mono">{cred.name}</span>: {cred.configured ? <Badge tone="info">Present, unused in this build</Badge> : <Badge>Not configured</Badge>}
              </li>
            ))}
            <li>
              <span className="mono">OPERATOR_PASSPHRASE</span>: {c.operatorPassphraseSet ? <Badge tone="ok">Set: required to sign in</Badge> : <Badge tone="warn">Not set: one-click local sign-in</Badge>}
            </li>
          </ul>
        </section>

        <section className="card" aria-labelledby="budget-h">
          <h2 id="budget-h">Budgets and limits</h2>
          <dl className="details">
            <dt>Spend per investigation</dt>
            <dd>{c.maxCostCents} cents (mock mode spends 0)</dd>
            <dt>Requests per investigation</dt>
            <dd>{c.maxRequests}</dd>
            <dt>Pages per website</dt>
            <dd>{c.maxPagesPerSite}</dd>
            <dt>Retries per investigation</dt>
            <dd>{c.maxRetries}</dd>
            <dt>Investigations per hour</dt>
            <dd>{c.maxRunsPerHour}</dd>
            <dt>Evidence freshness window</dt>
            <dd>{c.staleAfterDays} days</dd>
            <dt>Session length</dt>
            <dd>{c.sessionTtlMinutes} minutes</dd>
            <dt>Outreach approval lifetime</dt>
            <dd>{c.approvalTtlMinutes} minutes</dd>
          </dl>
          <p className="small muted">Change these in .env.local and restart. See .env.example for names.</p>
        </section>

        <section className="card" aria-labelledby="src-h">
          <h2 id="src-h">Sources and permissions</h2>
          <ul>
            <li>
              Business website (synthetic fixtures): <Badge tone="ok">Enabled</Badge>
            </li>
            <li>
              Business website (live fetch): <Badge>Built, not enabled, not live-tested</Badge>
            </li>
            <li>
              Manual observations entered by you: <Badge tone="ok">Enabled</Badge>
            </li>
            <li>
              Google Places discovery: <Badge>Not built</Badge>
            </li>
            <li>
              Search and AI-search sampling: <Badge>Not built</Badge>
            </li>
            <li>
              Reddit and Facebook: <Badge>Manual review only</Badge> Logged-in or private content is never collected automatically.
            </li>
            <li>
              Yelp and other review APIs: <Badge>Not built</Badge>
            </li>
          </ul>
        </section>

        <section className="card" aria-labelledby="privacy-h">
          <h2 id="privacy-h">Retention, export and delete</h2>
          <ul>
            <li>Data is stored in one local file ({c.dataDir}/db.json) on this machine, excluded from version control.</li>
            <li>Raw page HTML is never stored; only bounded, derived facts and short excerpts.</li>
            <li>
              Retention policy: <Badge tone="warn">Not defined</Badge> Must be decided before any live data is collected.
            </li>
            <li>
              Delete and full export from the app: <Badge>Not built</Badge> Until then, stop the app and delete the data file to remove everything.
            </li>
            <li>Reports are private. There are no share links. The owner version can only be downloaded by you after a separate approval.</li>
          </ul>
        </section>

        <section className="card" aria-labelledby="out-h">
          <h2 id="out-h">Outbound actions</h2>
          <p>
            <Badge tone="ok">None possible</Badge> This build contains no code that sends email, submits forms, posts, or places calls. Outreach is copy-only, and recording a draft as sent needs your one-time approval of the exact text.
          </p>
        </section>
      </div>

      <section aria-labelledby="audit">
        <h2 id="audit">Audit trail (latest {audit.length})</h2>
        {audit.length === 0 ? (
          <p className="muted">No actions recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Time iso={a.at} />
                    </td>
                    <td>{a.actorKind}</td>
                    <td className="mono">{a.action}</td>
                    <td className="mono break">
                      {a.targetType} {a.targetId.slice(0, 12)}
                    </td>
                    <td className="break">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">Entries are append-only: the app has no function that edits or deletes them.</p>
      </section>
    </>
  );
}
