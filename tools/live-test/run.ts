// Operator live test: one investigation of one approved business website.
//
// This is the ONLY place a real request can originate. It is separate from the
// web application, which stays mock-only. It can reach nothing but the exact
// hostnames approved for the one business it was asked to investigate.
//
// What it will not do: follow links to other sites, submit a form, send a
// cookie, log in, retry a refusal, or get around robots.txt or a bot check.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@/lib/config';
import type { Ctx } from '@/lib/context';
import { isAppError } from '@/lib/errors';
import { MockRuleReasoner } from '@/lib/reasoning/reasoner';
import { createApprovedLiveTransport, type ApprovedLiveDeps } from '@/lib/security/safe-fetch';
import { confirmIdentity, createBusiness } from '@/lib/services/businesses';
import { resumeInvestigation, startInvestigation } from '@/lib/services/investigations';
import { JsonFileStore } from '@/lib/store';
import type { ApprovedBusiness, Approvals } from './approvals';
import { renderInternalMarkdown, type LiveRunSummary } from './report';

/** Conservative limits for a hand-supervised test. Deliberately not configurable from the environment. */
export const LIVE_TEST_LIMITS = {
  maxPages: 5,
  requestCap: 8,
  timeoutMs: 10_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  minDelayMs: 2_000,
  maxWireRequests: 20,
} as const;

export const OPERATOR_ID = 'usr_local-operator';

export type LiveRunResult = { summary: LiveRunSummary; reportPath: string; dataPath: string; status: string; markdown: string };

export async function runLiveInvestigation(input: {
  approvals: Approvals;
  label: string;
  /** folder for this test's data and reports; must not be inside version control */
  outDir: string;
  /** network pieces; tests substitute controlled local servers. Leave empty for a real run. */
  deps?: Partial<ApprovedLiveDeps>;
  /** tests shorten the pauses and timeouts; a real run uses LIVE_TEST_LIMITS as they are */
  limits?: Partial<Record<keyof typeof LIVE_TEST_LIMITS, number>>;
  log?: (line: string) => void;
}): Promise<LiveRunResult> {
  const say = input.log ?? (() => undefined);
  const approved: ApprovedBusiness | undefined = input.approvals.businesses.find((b) => b.label === input.label);
  if (!approved) throw new Error(`No approved business with label "${input.label}". Labels in the approvals file: ${input.approvals.businesses.map((b) => b.label).join(', ')}.`);
  const limits = { ...LIVE_TEST_LIMITS, ...(input.limits ?? {}) };

  // Only this business's hostnames. The other approved businesses are out of reach for this run.
  const transport = createApprovedLiveTransport(
    { approvedHosts: approved.approvedHosts, timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes, maxRedirects: limits.maxRedirects, minDelayMs: limits.minDelayMs, maxWireRequests: limits.maxWireRequests },
    input.deps ?? {},
  );

  const dataDir = path.join(input.outDir, 'data', approved.label);
  // A fresh store per run keeps runs independent and makes the evidence trail easy to follow.
  fs.rmSync(dataDir, { recursive: true, force: true });
  const store = new JsonFileStore(dataDir);
  const ctx: Ctx = {
    store,
    // In memory only: the application's own configuration cannot produce these two values.
    config: { ...loadConfig({}), mode: 'live_test', liveFetchUnlocked: true, maxPagesPerSite: limits.maxPages, maxRequests: limits.requestCap, maxRetries: 0 },
    // The operator started this run. Nothing below reviews or approves anything on their behalf.
    actor: { userId: OPERATOR_ID, kind: 'human' },
    now: () => new Date(),
    transport,
    reasoner: new MockRuleReasoner(),
  };

  const started = Date.now();
  say(`live-test ${approved.label}: may request only ${approved.approvedHosts.join(', ')}`);
  const business = createBusiness(ctx, { displayName: approved.displayName, domain: approved.domain, phone: approved.phone ?? undefined, city: approved.city, state: approved.state });
  let run = await startInvestigation(ctx, { businessId: business.id });
  let identityConfirmedBy: LiveRunSummary['identityConfirmedBy'] = 'not_confirmed';
  const identityNow = () => store.snapshot().businesses.find((b) => b.id === business.id)!.identityStatus;

  if (identityNow() === 'confirmed') {
    identityConfirmedBy = 'site_text';
  } else if (run.status === 'blocked' && approved.operatorConfirmsIdentity) {
    // The site's own text did not confirm name and location. The operator stated, in the
    // approval record, that this website belongs to this business; that statement is used here.
    const homeOk = store.snapshot().sourceRecords.some((r) => r.runId === run.id && r.sourceType === 'website' && r.accessStatus === 'ok');
    if (homeOk) {
      confirmIdentity(ctx, business.id, `Operator approval record (${input.approvals.approvedAt}): this website belongs to this business.`);
      try {
        run = await resumeInvestigation(ctx, run.id);
        identityConfirmedBy = 'operator';
      } catch (e) {
        if (!isAppError(e)) throw e;
        say(`live-test ${approved.label}: could not resume after identity confirmation: ${e.message}`);
      }
    }
  }
  const finished = Date.now();

  const summary: LiveRunSummary = {
    label: approved.label,
    runId: run.id,
    businessId: business.id,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    wallClockMs: finished - started,
    approvedHosts: [...approved.approvedHosts],
    requestLog: [...transport.log],
    wireRequests: transport.wireRequests(),
    identityConfirmedBy,
    limits,
  };
  const db = store.snapshot();
  const markdown = renderInternalMarkdown(db, summary, approved);
  const reportDir = path.join(input.outDir, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${approved.label}-internal-report.md`);
  fs.writeFileSync(reportPath, markdown, 'utf8');
  fs.writeFileSync(path.join(reportDir, `${approved.label}-run-summary.json`), JSON.stringify(summary, null, 2), 'utf8');
  say(`live-test ${approved.label}: status ${run.status}; ${summary.requestLog.length} page request(s), ${summary.wireRequests} on the wire; report ${reportPath}`);
  return { summary, reportPath, dataPath: path.join(dataDir, 'db.json'), status: run.status, markdown };
}
