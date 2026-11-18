import Link from 'next/link';
import { createBusinessAction, investigateExampleAction, resolveDuplicateAction, startInvestigationAction } from '../actions';
import { Badge, Empty, Field, MockBadge, NoticeBanner, PageHeader, StatusBadge } from '@/components/ui';
import { GOLDEN_CASES } from '@/fixtures/golden';
import { readNotice } from '@/lib/auth';
import { requireCtx } from '@/lib/runtime';
import { listBusinesses } from '@/lib/services/businesses';
import { listRuns } from '@/lib/services/investigations';

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const ctx = await requireCtx();
  const { n } = await searchParams;
  const businesses = listBusinesses(ctx);
  const runs = listRuns(ctx);
  const placesKey = ctx.config.credentials.find((c) => c.name === 'GOOGLE_PLACES_API_KEY')?.configured ?? false;
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/', label: 'Home' }, { label: 'Discover' }]}
        title="Choose businesses to investigate"
        subtitle="Add one business by hand, or run a synthetic example. Investigations start one at a time; nothing is researched in bulk."
      />
      <NoticeBanner notice={readNotice(ctx.store, ctx.actor.userId, n)} />

      <div className="callout">
        <strong>Fastest way to see the whole workflow:</strong> mock mode cannot fetch real websites, so <a href="#examples-h">choose a synthetic example below</a> and press “Investigate”. A business you add by hand can still be researched with observations you record yourself.
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="manual-h">
          <h2 id="manual-h">Add a business by hand</h2>
          <form action={createBusinessAction}>
            <Field label="Business name">
              <input type="text" name="displayName" required maxLength={120} autoComplete="off" />
            </Field>
            <Field label="Website (optional)" hint="For example: example.com. In mock mode a real website is not fetched.">
              <input type="text" name="domain" maxLength={300} autoComplete="off" inputMode="url" />
            </Field>
            <div className="form-grid">
              <Field label="City">
                <input type="text" name="city" required maxLength={80} autoComplete="off" />
              </Field>
              <Field label="State (2 letters)">
                <input type="text" name="state" required maxLength={2} minLength={2} defaultValue="MI" autoComplete="off" />
              </Field>
            </div>
            <Field label="Published business phone (optional)" hint="Used only to detect duplicates and check identity.">
              <input type="text" name="phone" maxLength={40} autoComplete="off" inputMode="tel" />
            </Field>
            <button type="submit" className="btn-primary">
              Add business
            </button>
          </form>
        </section>

        <section className="card" aria-labelledby="provider-h">
          <h2 id="provider-h">Find businesses automatically</h2>
          <p>
            <Badge tone="neutral">Not available</Badge> Discovery by service and city (Google Places) is planned for a later phase and is not built.
          </p>
          <dl className="details">
            <dt>Discovery provider</dt>
            <dd>None enabled</dd>
            <dt>Places API key</dt>
            <dd>{placesKey ? 'Configured, but unused in this build' : 'Not configured'}</dd>
            <dt>Service</dt>
            <dd>HVAC (default)</dd>
            <dt>Spend</dt>
            <dd>0 cents. No paid API is called.</dd>
          </dl>
          <p className="muted small">Manual entry always works and is the only path today.</p>
        </section>
      </div>

      <section aria-labelledby="examples-h">
        <h2 id="examples-h">
          Synthetic examples <MockBadge />
        </h2>
        <p className="muted">Fictional businesses with fictional websites, built to exercise specific situations. Use them to learn the workflow; never present them as real research.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Example</th>
                <th scope="col">What it exercises</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {GOLDEN_CASES.map((c) => (
                <tr key={c.key}>
                  <td>
                    <strong>{c.label}</strong>
                    <br />
                    <span className="muted small">{c.businesses[0]!.displayName}</span>
                  </td>
                  <td>{c.purpose}</td>
                  <td>
                    <form action={investigateExampleAction}>
                      <input type="hidden" name="key" value={c.key} />
                      <button type="submit" aria-label={`Investigate example: ${c.label}`}>
                        Investigate
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="list-h">
        <h2 id="list-h">Your businesses</h2>
        {businesses.length === 0 ? (
          <Empty title="No businesses yet.">
            <p>Add one by hand above, or choose “Investigate” on a synthetic example.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Business</th>
                  <th scope="col">Location</th>
                  <th scope="col">Website</th>
                  <th scope="col">Identity</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {businesses.map((b) => {
                  const latest = runs.find((r) => r.business.id === b.id);
                  const other = b.possibleDuplicateOf ? businesses.find((x) => x.id === b.possibleDuplicateOf) : null;
                  return (
                    <tr key={b.id}>
                      <td className="break">
                        {b.displayName} {b.synthetic ? <MockBadge /> : null}
                      </td>
                      <td>
                        {b.city}, {b.state}
                      </td>
                      <td className="break">{b.domain ?? <span className="muted">None on record</span>}</td>
                      <td>
                        {b.identityStatus === 'confirmed' ? <Badge tone="ok">Matched website</Badge> : b.identityStatus === 'confirmed_by_operator' ? <Badge tone="ok">Confirmed by you</Badge> : b.identityStatus === 'ambiguous' ? <Badge tone="warn">Ambiguous</Badge> : <Badge>Not verified</Badge>}
                      </td>
                      <td>
                        {b.duplicateResolution === 'marked_duplicate' ? (
                          <span className="muted">Marked as duplicate of {other?.displayName ?? 'another entry'}; not investigated.</span>
                        ) : b.duplicateResolution === 'unresolved' ? (
                          <details>
                            <summary>Possible duplicate of {other?.displayName ?? 'another entry'}: decide</summary>
                            <form action={resolveDuplicateAction}>
                              <input type="hidden" name="businessId" value={b.id} />
                              <Field label="Reason for your decision">
                                <input type="text" name="reason" required minLength={3} maxLength={200} />
                              </Field>
                              <div className="button-row">
                                <button type="submit" name="resolution" value="kept_separate">
                                  Keep as separate business
                                </button>
                                <button type="submit" name="resolution" value="marked_duplicate">
                                  Mark as duplicate
                                </button>
                              </div>
                            </form>
                          </details>
                        ) : (
                          <div className="button-row">
                            <form action={startInvestigationAction}>
                              <input type="hidden" name="businessId" value={b.id} />
                              <button type="submit" aria-label={`Investigate ${b.displayName}`}>
                                {latest ? 'Investigate again' : 'Investigate'}
                              </button>
                            </form>
                            {latest ? (
                              <span>
                                <Link href={`/investigations/${latest.run.id}`}>Latest run</Link> <StatusBadge status={latest.run.status} />
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
