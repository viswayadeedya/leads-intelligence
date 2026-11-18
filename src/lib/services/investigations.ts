// Investigation orchestrator: an explicit, re-entrant state machine.
//
//   queued -> resolving_identity -> collecting -> analyzing -> verifying
//          -> review_ready | partial | blocked | failed | canceled
//
// Every step checkpoints to the store and is idempotent: calling advance again
// (resume after identity confirmation, or "Retry failed source") never
// refetches a page that succeeded and never duplicates records or evidence.
// No loops without a bound; no model decides what to fetch.

import { findCaseByKey } from '@/fixtures/golden';
import { appendAudit, getOwned, listOwned, requireHuman, type Ctx } from '../context';
import { AppError, isAppError } from '../errors';
import { checkIdentityAgainstSite } from '../identity';
import { newId, sha256 } from '../ids';
import { logEvent } from '../log';
import { candidatePaths, detectSignals, extractPage, type PageFacts } from '../sources/html-extract';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsPolicy } from '../sources/robots';
import type { FetchOutcome } from '../sources/transport';
import { aggregateWebsiteEvidence, pathOf } from '../sources/website-evidence';
import type { Business, Db, ErrorCode, InvestigationRun, PageExtract, RunStatus, SourceRecord, StageKey, StageState, StageStatus } from '../types';
import { analyzeRun } from './analysis';
import { seedFixtureNotes } from './evidence';

const ROBOTS_AGENT = 'opportunityintelligenceresearch';

function initialStages(): StageState[] {
  const keys: StageKey[] = ['identity', 'website', 'public_signals', 'evidence_review', 'report'];
  return keys.map((key) => ({ key, status: 'pending', note: '', updatedAt: null }));
}

function mutateRun<T>(ctx: Ctx, runId: string, fn: (run: InvestigationRun, db: Db) => T): T {
  return ctx.store.transact((db) => fn(getOwned(db.runs, runId, ctx.actor, 'Investigation'), db));
}

function setStage(run: InvestigationRun, key: StageKey, status: StageStatus, note: string, nowIso: string): void {
  const stage = run.stages.find((s) => s.key === key)!;
  stage.status = status;
  stage.note = note;
  stage.updatedAt = nowIso;
}

function addError(run: InvestigationRun, code: ErrorCode, message: string): void {
  if (!run.errorSummary.some((e) => e.code === code && e.message === message)) run.errorSummary.push({ code, message });
}

export function describeOutcome(outcome: FetchOutcome): { detail: string; code: ErrorCode | null } {
  if (outcome.kind === 'ok') return { detail: `HTTP ${outcome.httpStatus}`, code: null };
  const r = outcome.reason;
  if (outcome.kind === 'restricted') {
    if (r === 'robots_disallow') return { detail: 'Not fetched: disallowed by robots.txt', code: 'access_denied' };
    if (r === 'robots_unreachable') return { detail: 'Not fetched: robots.txt could not be read, so access was not assumed', code: 'access_denied' };
    if (r === 'rate_limited') return { detail: 'Rate limited by the site (HTTP 429); stopped', code: 'rate_limited' };
    if (r === 'captcha_or_bot_challenge') return { detail: 'Bot challenge shown; stopped without attempting to pass it', code: 'access_denied' };
    if (r === 'redirected_off_domain') return { detail: 'Redirected to a different site; not followed', code: 'access_denied' };
    return { detail: `Access refused (HTTP ${outcome.httpStatus ?? '?'})`, code: 'access_denied' };
  }
  if (outcome.kind === 'unavailable') {
    if (r === 'mock_fixture_missing') return { detail: 'No synthetic fixture for this address', code: 'source_unavailable' };
    if (r === 'dns_failure') return { detail: 'The site address could not be resolved', code: 'source_unavailable' };
    if (r === 'tls_error') return { detail: "The site's security certificate could not be verified; not fetched", code: 'source_unavailable' };
    if (r === 'empty_response') return { detail: 'The page was empty', code: 'source_unavailable' };
    if (r === 'incomplete_response') return { detail: 'The connection closed before the page finished loading', code: 'source_unavailable' };
    if (r === 'too_many_redirects') return { detail: 'Too many redirects; stopped', code: 'source_unavailable' };
    return { detail: outcome.httpStatus ? `Page unavailable (HTTP ${outcome.httpStatus})` : 'Page unavailable', code: 'source_unavailable' };
  }
  if (r === 'timeout') return { detail: 'Timed out', code: 'timeout' };
  if (r.startsWith('security_blocked')) return { detail: 'Blocked by the safe-fetch rules', code: 'security_blocked' };
  if (r === 'response_too_large') return { detail: 'Response larger than the size limit', code: 'extraction_failed' };
  if (r === 'content_type_not_allowed') return { detail: 'Not an HTML page', code: 'extraction_failed' };
  if (r === 'malformed_response') return { detail: 'The site sent a response that is not valid HTTP', code: 'extraction_failed' };
  if (r === 'unsupported_content_encoding' || r === 'unsupported_charset' || r === 'undecodable_body' || r === 'binary_body') {
    return { detail: 'The page was sent in an encoding that cannot be read reliably; not inspected', code: 'extraction_failed' };
  }
  return { detail: 'Could not be processed', code: 'extraction_failed' };
}

/**
 * Live website fetching is locked. A transport that is not the bundled
 * synthetic fixtures is refused unless the in-memory switch is set, and no
 * configuration file or environment variable can set it.
 */
function assertTransportAllowed(ctx: Ctx): void {
  if (!ctx.transport.synthetic && ctx.config.liveFetchUnlocked !== true) {
    throw new AppError('forbidden', 'Live website fetching is not enabled in this build. Nothing was requested.');
  }
}

function toExtract(path: string, facts: PageFacts): PageExtract {
  const signals = detectSignals(facts);
  return {
    path,
    title: facts.title,
    phones: facts.phones,
    bookingLinks: signals.bookingLinks,
    contactFormFieldCounts: signals.contactForms.map((f) => f.fieldCount),
    afterHours: signals.afterHours,
    phoneScheduling: signals.phoneScheduling,
    hours: signals.hours,
    copyrightYear: signals.copyrightYear,
    instructionLike: signals.instructionLike,
  };
}

/** Counts one request against the run budget. Returns false when the cap is reached. */
function takeRequest(ctx: Ctx, runId: string): boolean {
  return mutateRun(ctx, runId, (run) => {
    const cost = ctx.transport.costCentsPerRequest;
    if (run.requestsUsed >= run.requestCap || run.spentCents + cost > run.budgetCents) {
      run.budgetExhausted = true;
      return false;
    }
    run.requestsUsed += 1;
    run.spentCents += cost;
    return true;
  });
}

type FetchResult = { record: SourceRecord | null; facts: PageFacts | null };

async function fetchPath(ctx: Ctx, run: InvestigationRun, base: string, path: string, policy: RobotsPolicy, robotsReason: string, retry: boolean): Promise<FetchResult> {
  const url = `${base}${path}`;
  const existing = ctx.store.snapshot().sourceRecords.find((r) => r.runId === run.id && r.sourceType === 'website' && r.sourceUrl === url) ?? null;
  if (existing && existing.accessStatus === 'ok') return { record: existing, facts: null };
  if (existing && !(retry && existing.retryable)) return { record: existing, facts: null };

  let outcome: FetchOutcome;
  let facts: PageFacts | null = null;
  let extracted: PageExtract | null = null;
  let checksum: string | null = null;
  const started = Date.now();
  if (!policy.isAllowed(path)) {
    outcome = { kind: 'restricted', reason: robotsReason, httpStatus: null };
  } else {
    if (!takeRequest(ctx, run.id)) return { record: existing, facts: null };
    outcome = await ctx.transport.fetchPage(url, existing?.attempts ?? 0);
    if (outcome.kind === 'ok') {
      try {
        facts = extractPage(outcome.body, outcome.finalUrl);
        extracted = toExtract(path, facts);
        checksum = sha256(outcome.body);
      } catch {
        outcome = { kind: 'error', reason: 'extraction_failed', retryable: false };
        facts = null;
      }
    }
  }
  const described = describeOutcome(outcome);
  logEvent({ action: 'source.fetch', result: outcome.kind === 'ok' ? 'ok' : 'error', runId: run.id, adapter: ctx.transport.id, durationMs: Date.now() - started, costCents: ctx.transport.costCentsPerRequest, outcome: outcome.kind });

  const record = ctx.store.transact((db) => {
    const now = ctx.now().toISOString();
    const row = db.sourceRecords.find((r) => r.runId === run.id && r.sourceType === 'website' && r.sourceUrl === url);
    const fields = {
      retrievedAt: now,
      accessStatus: outcome.kind,
      accessDetail: described.detail,
      checksum,
      extracted,
      retryable: outcome.kind === 'error' || outcome.kind === 'unavailable' ? outcome.retryable : false,
    } as const;
    if (row) {
      Object.assign(row, fields);
      row.attempts += 1;
      return row;
    }
    const created: SourceRecord = {
      id: newId('src'),
      ownerId: run.ownerId,
      runId: run.id,
      businessId: run.businessId,
      sourceType: 'website',
      sourceUrl: url,
      provider: ctx.transport.id,
      permittedStorageClass: 'PUBLIC_BUSINESS',
      queryContext: { path },
      notes: '',
      attempts: 1,
      synthetic: ctx.transport.synthetic,
      ...fields,
    };
    db.sourceRecords.push(created);
    return created;
  });
  return { record, facts };
}

function websiteStage(records: SourceRecord[]): { status: StageStatus; note: string } {
  const ok = records.filter((r) => r.accessStatus === 'ok').length;
  const restricted = records.filter((r) => r.accessStatus === 'restricted').length;
  const failed = records.length - ok - restricted;
  const total = records.length;
  if (total === 0) return { status: 'failed', note: 'No page could be requested.' };
  if (ok === total) return { status: 'complete', note: `${ok} of ${total} pages inspected.` };
  const parts = [`${ok} of ${total} pages inspected`];
  if (restricted > 0) parts.push(`${restricted} access restricted`);
  if (failed > 0) parts.push(`${failed} failed or unavailable`);
  const note = `${parts.join('; ')}. The report can continue with limitations.`;
  if (ok > 0) return { status: 'partial', note };
  return { status: restricted > 0 ? 'restricted' : 'failed', note: `${parts.join('; ')}. Nothing can be concluded about the business from this source.` };
}

function upsertWebsiteEvidence(db: Db, ctx: Ctx, run: InvestigationRun, business: Business): void {
  const records = db.sourceRecords.filter((r) => r.runId === run.id);
  const now = ctx.now();
  const { evidence, unknowns } = aggregateWebsiteEvidence({
    records,
    plannedPaths: run.queryScope.plannedPaths,
    budgetExhausted: run.budgetExhausted,
    nowYear: now.getUTCFullYear(),
  });
  const identityConfirmed = business.identityStatus === 'confirmed' || business.identityStatus === 'confirmed_by_operator';
  const produced = new Set<string>();
  for (const candidate of evidence) {
    produced.add(candidate.dedupeKey);
    const current = db.evidence.find((e) => e.runId === run.id && e.dedupeKey === candidate.dedupeKey && !e.supersededBy);
    if (current && current.checksum === candidate.checksum) {
      current.identityMatchStatus = identityConfirmed ? 'confirmed' : 'uncertain';
      continue;
    }
    const id = newId('ev');
    db.evidence.push({
      id,
      ownerId: run.ownerId,
      runId: run.id,
      businessId: run.businessId,
      observedAt: now.toISOString(),
      identityMatchStatus: identityConfirmed ? 'confirmed' : 'uncertain',
      verificationStatus: 'needs_review',
      reviewNote: null,
      topic: null,
      stance: null,
      supersededBy: null,
      synthetic: ctx.transport.synthetic,
      createdAt: now.toISOString(),
      ...candidate,
    });
    if (current) {
      // Observations are immutable: the old one is kept and marked replaced.
      current.supersededBy = id;
      appendAudit(db, ctx, 'evidence.superseded', 'evidence', current.id, 'Replaced after more pages were inspected.', 'system');
    }
  }
  // A website observation that no longer follows from the inspected pages is retired.
  for (const stale of db.evidence.filter((e) => e.runId === run.id && e.dedupeKey.startsWith('website:') && !e.supersededBy && !produced.has(e.dedupeKey))) {
    stale.supersededBy = 'withdrawn';
    appendAudit(db, ctx, 'evidence.superseded', 'evidence', stale.id, 'Withdrawn after re-inspection.', 'system');
  }
  run.unknowns = unknowns.map((u) => ({ id: newId('unk'), ...u }));
}

async function advance(ctx: Ctx, runId: string, retry: boolean): Promise<void> {
  assertTransportAllowed(ctx);
  const nowIso = () => ctx.now().toISOString();
  let snap = ctx.store.snapshot();
  let run = getOwned(snap.runs, runId, ctx.actor, 'Investigation');
  let business = getOwned(snap.businesses, run.businessId, ctx.actor, 'Business');
  if (run.status === 'canceled' || run.status === 'failed') throw new AppError('conflict', `This investigation is ${run.status} and cannot continue.`);

  mutateRun(ctx, runId, (r) => {
    r.status = 'resolving_identity';
    r.startedAt = r.startedAt ?? nowIso();
    r.finishedAt = null;
    r.errorSummary = [];
    // Recomputed on every pass: set again by takeRequest if the cap is still hit.
    r.budgetExhausted = false;
  });

  const finish = (status: RunStatus) =>
    mutateRun(ctx, runId, (r, db) => {
      r.status = status;
      r.finishedAt = nowIso();
      appendAudit(db, ctx, 'run.finished', 'run', r.id, `Status ${status}; ${r.requestsUsed} request(s); ${r.spentCents} cent(s).`, 'system');
    });

  // ---- duplicate gate -------------------------------------------------
  if (business.possibleDuplicateOf && business.duplicateResolution !== 'kept_separate') {
    mutateRun(ctx, runId, (r) => {
      setStage(r, 'identity', 'partial', 'This business looks like a duplicate of another entry. Decide whether to keep it separate before investigating.', nowIso());
      addError(r, 'duplicate_unresolved', 'Possible duplicate business must be resolved first.');
    });
    finish('blocked');
    return;
  }

  // ---- identity + website --------------------------------------------
  const host = business.domain;
  const canHandle = host ? (ctx.transport.canHandle ? ctx.transport.canHandle(host) : true) : false;
  let identityBlocked = false;

  if (!host || !canHandle) {
    const why = !host
      ? 'No website is on record for this business.'
      : 'Mock mode has no synthetic fixture for this website, and live website checks are not enabled in this build. Nothing was fetched.';
    mutateRun(ctx, runId, (r) => {
      setStage(r, 'identity', 'not_checked', `${why} Identity was not checked against a website.`, nowIso());
      setStage(r, 'website', 'not_checked', why, nowIso());
    });
  } else {
    const base = `https://${host}`;
    mutateRun(ctx, runId, (r) => setStage(r, 'identity', 'running', 'Checking the business against its own website.', nowIso()));

    // robots.txt first. It is an access signal we honor, not a permission grant.
    if (run.robots.status === 'not_fetched' || (retry && run.robots.status === 'unreachable')) {
      if (takeRequest(ctx, runId)) {
        const outcome = await ctx.transport.fetchPage(`${base}/robots.txt`, 0);
        mutateRun(ctx, runId, (r) => {
          if (outcome.kind === 'ok') r.robots = { status: 'ok', text: outcome.body.slice(0, 20_000) };
          else if (outcome.kind === 'restricted') r.robots = { status: 'none', text: null };
          else if (outcome.kind === 'unavailable' && outcome.httpStatus !== null && outcome.httpStatus < 500) r.robots = { status: 'none', text: null };
          else r.robots = { status: 'unreachable', text: null };
        });
      }
    }
    run = getOwned(ctx.store.snapshot().runs, runId, ctx.actor, 'Investigation');
    const policy: RobotsPolicy =
      run.robots.status === 'ok' ? parseRobots(run.robots.text ?? '', ROBOTS_AGENT) : run.robots.status === 'none' ? ALLOW_ALL : DISALLOW_ALL;
    const robotsReason = run.robots.status === 'ok' ? 'robots_disallow' : 'robots_unreachable';

    const home = await fetchPath(ctx, run, base, '/', policy, robotsReason, retry);
    if (home.facts) {
      const facts = home.facts;
      const check = checkIdentityAgainstSite(business, { title: facts.title, text: facts.text, phones: facts.phones });
      ctx.store.transact((db) => {
        const b = getOwned(db.businesses, business.id, ctx.actor, 'Business');
        const r = getOwned(db.runs, runId, ctx.actor, 'Investigation');
        if (b.identityStatus !== 'confirmed_by_operator') {
          b.identityStatus = check.status;
          b.identityNotes = check.reasons;
        }
        if (r.queryScope.plannedPaths === null) {
          r.queryScope.plannedPaths = candidatePaths(facts, Math.max(0, r.queryScope.maxPages - 1));
        }
      });
    }
    snap = ctx.store.snapshot();
    business = getOwned(snap.businesses, business.id, ctx.actor, 'Business');
    run = getOwned(snap.runs, runId, ctx.actor, 'Investigation');
    const homeOk = home.record?.accessStatus === 'ok';
    const identityConfirmed = business.identityStatus === 'confirmed' || business.identityStatus === 'confirmed_by_operator';

    if (!homeOk) {
      mutateRun(ctx, runId, (r) => {
        const detail = home.record ? home.record.accessDetail : 'the request budget was reached before the home page could be requested';
        setStage(r, 'identity', home.record?.accessStatus === 'restricted' ? 'restricted' : home.record ? 'failed' : 'not_checked', `Identity could not be checked against the website (${detail}).`, nowIso());
      });
    } else if (!identityConfirmed) {
      identityBlocked = true;
      mutateRun(ctx, runId, (r) => {
        setStage(r, 'identity', 'partial', `Needs your review. ${business.identityNotes.join(' ')}`, nowIso());
        addError(r, 'identity_ambiguous', 'Business identity could not be confirmed from the website. The investigation stopped before collecting evidence.');
      });
    } else {
      mutateRun(ctx, runId, (r) => {
        setStage(r, 'identity', 'complete', business.identityStatus === 'confirmed_by_operator' ? 'Confirmed manually by the operator.' : 'Name and location match the website.', nowIso());
        r.status = 'collecting';
        setStage(r, 'website', 'running', 'Inspecting contact and booking pages.', nowIso());
      });
      for (const path of run.queryScope.plannedPaths ?? []) {
        await fetchPath(ctx, run, base, path, policy, robotsReason, retry);
      }
    }

    if (!identityBlocked) {
      mutateRun(ctx, runId, (r, db) => {
        const records = db.sourceRecords.filter((s) => s.runId === runId && s.sourceType === 'website');
        const stage = websiteStage(records);
        const planned = r.queryScope.plannedPaths ?? [];
        const unreached = planned.filter((p) => !records.some((s) => pathOf(s) === p)).length;
        if (r.budgetExhausted) {
          addError(r, 'budget_exceeded', `The request budget (${r.requestCap} requests, ${r.budgetCents} cents) was reached. ${unreached} planned page(s) were not requested. Collected evidence was kept.`);
          setStage(r, 'website', stage.status === 'complete' ? 'partial' : stage.status, `${stage.note} Stopped at the request budget.`, nowIso());
        } else {
          setStage(r, 'website', stage.status, stage.note, nowIso());
        }
        for (const s of records.filter((x) => x.accessStatus !== 'ok')) {
          const code: ErrorCode = s.accessStatus === 'restricted' ? 'access_denied' : s.accessDetail === 'Timed out' ? 'timeout' : 'source_unavailable';
          addError(r, code, `${pathOf(s)}: ${s.accessDetail}`);
        }
      });
    } else {
      mutateRun(ctx, runId, (r) => setStage(r, 'website', 'pending', 'Waiting for identity review.', nowIso()));
    }
  }

  if (identityBlocked) {
    finish('blocked');
    return;
  }

  // ---- public signals (manual in this build) ---------------------------
  mutateRun(ctx, runId, (r, db) => {
    const b = getOwned(db.businesses, r.businessId, ctx.actor, 'Business');
    if (!r.fixtureNotesSeeded && ctx.transport.synthetic && b.synthetic && b.fixtureKey) {
      const golden = findCaseByKey(b.fixtureKey);
      if (golden?.notes) seedFixtureNotes(db, ctx, r, golden.notes);
      r.fixtureNotesSeeded = true;
    }
    const manual = db.evidence.filter((e) => e.runId === runId && e.dedupeKey.startsWith('manual:')).length;
    if (manual > 0) {
      setStage(r, 'public_signals', 'complete', `${manual} manually recorded observation(s). No automated public-signal source is enabled.`, nowIso());
    } else {
      setStage(r, 'public_signals', 'not_checked', 'No automated public-signal source is enabled in this build. Record observations by hand in the evidence desk.', nowIso());
    }
    r.status = 'analyzing';
    upsertWebsiteEvidence(db, ctx, r, b);
  });

  // ---- reasoning + verification ---------------------------------------
  mutateRun(ctx, runId, (r) => {
    r.status = 'verifying';
  });
  const { outputInvalid } = await analyzeRun(ctx, runId);

  const final = mutateRun(ctx, runId, (r) => {
    if (outputInvalid) addError(r, 'model_invalid_output', 'The reasoner output was invalid. No claims were accepted; evidence can still be reviewed by hand.');
    const website = r.stages.find((s) => s.key === 'website')!.status;
    const clean = website === 'complete' && !r.budgetExhausted && !outputInvalid;
    return clean ? 'review_ready' : 'partial';
  });
  finish(final);
}

async function advanceSafely(ctx: Ctx, runId: string, retry: boolean): Promise<InvestigationRun> {
  try {
    await advance(ctx, runId, retry);
  } catch (e) {
    if (isAppError(e)) throw e;
    // An unexpected failure must never look like a clean result.
    logEvent({ action: 'run.advance', result: 'error', runId, error: e instanceof Error ? e.name : 'unknown' });
    mutateRun(ctx, runId, (r, db) => {
      r.status = 'failed';
      r.finishedAt = ctx.now().toISOString();
      addError(r, 'extraction_failed', 'The investigation stopped because of an unexpected internal error. No conclusions were drawn.');
      appendAudit(db, ctx, 'run.failed', 'run', r.id, 'Unexpected internal error.', 'system');
    });
  }
  return getRun(ctx, runId);
}

export async function startInvestigation(ctx: Ctx, input: { businessId: string; idempotencyKey?: string | null }): Promise<InvestigationRun> {
  requireHuman(ctx.actor, 'Starting an investigation');
  assertTransportAllowed(ctx);
  const key = input.idempotencyKey && input.idempotencyKey.length <= 100 ? input.idempotencyKey : null;
  const created = ctx.store.transact((db) => {
    const business = getOwned(db.businesses, input.businessId, ctx.actor, 'Business');
    if (business.duplicateResolution === 'marked_duplicate') {
      throw new AppError('conflict', 'This entry was marked as a duplicate. Investigate the original entry instead.');
    }
    const mine = listOwned(db.runs, ctx.actor);
    if (key) {
      const same = mine.find((r) => r.idempotencyKey === key);
      if (same) return { run: same, isNew: false };
    }
    // Duplicate-run stop rule: an unfinished run for the same business is reused.
    const open = mine.find((r) => r.businessId === business.id && (r.status === 'queued' || r.status === 'blocked'));
    if (open) return { run: open, isNew: false };

    const hourAgo = ctx.now().getTime() - 3_600_000;
    const recent = mine.filter((r) => new Date(r.createdAt).getTime() > hourAgo).length;
    if (recent >= ctx.config.maxRunsPerHour) {
      throw new AppError('rate_limited', `Limit reached: ${ctx.config.maxRunsPerHour} investigations per hour. Try again later or raise MAX_RUNS_PER_HOUR.`);
    }
    const run: InvestigationRun = {
      id: newId('run'),
      ownerId: ctx.actor.userId,
      businessId: business.id,
      status: 'queued',
      stages: initialStages(),
      startedAt: null,
      finishedAt: null,
      mode: ctx.config.mode,
      queryScope: { maxPages: ctx.config.maxPagesPerSite, plannedPaths: null },
      robots: { status: 'not_fetched', text: null },
      budgetExhausted: false,
      fixtureNotesSeeded: false,
      budgetCents: ctx.config.maxCostCents,
      spentCents: 0,
      requestCap: ctx.config.maxRequests,
      requestsUsed: 0,
      retriesUsed: 0,
      modelVersion: ctx.reasoner.version,
      errorSummary: [],
      unknowns: [],
      idempotencyKey: key,
      createdAt: ctx.now().toISOString(),
    };
    db.runs.push(run);
    appendAudit(db, ctx, 'run.started', 'run', run.id, `Mode ${run.mode}; cap ${run.requestCap} requests, ${run.budgetCents} cents.`);
    return { run, isNew: true };
  });
  if (!created.isNew) return created.run;
  return advanceSafely(ctx, created.run.id, false);
}

/** Continue a blocked run after the operator resolved identity or a duplicate flag. */
export async function resumeInvestigation(ctx: Ctx, runId: string): Promise<InvestigationRun> {
  requireHuman(ctx.actor, 'Resuming an investigation');
  const run = getRun(ctx, runId);
  if (run.status !== 'blocked' && run.status !== 'queued') throw new AppError('conflict', 'Only a blocked investigation can be resumed.');
  return advanceSafely(ctx, runId, false);
}

/** "Retry failed source": bounded, and only re-requests pages that failed in a retryable way. */
export async function retryFailedSources(ctx: Ctx, runId: string): Promise<InvestigationRun> {
  requireHuman(ctx.actor, 'Retrying a source');
  mutateRun(ctx, runId, (r, db) => {
    if (r.status !== 'partial') throw new AppError('conflict', 'Only a partial investigation has sources to retry.');
    const retryable = db.sourceRecords.some((s) => s.runId === runId && s.retryable) || r.robots.status === 'unreachable';
    if (!retryable) throw new AppError('conflict', 'Nothing to retry: the remaining sources are restricted or permanently unavailable. Restricted sources are not retried.');
    if (r.retriesUsed >= ctx.config.maxRetries) {
      throw new AppError('rate_limited', `Retry limit reached (${ctx.config.maxRetries} per investigation).`);
    }
    r.retriesUsed += 1;
    appendAudit(db, ctx, 'run.retry', 'run', r.id, `Retry ${r.retriesUsed} of ${ctx.config.maxRetries}.`);
  });
  return advanceSafely(ctx, runId, true);
}

export function cancelInvestigation(ctx: Ctx, runId: string): InvestigationRun {
  requireHuman(ctx.actor, 'Stopping an investigation');
  return mutateRun(ctx, runId, (r, db) => {
    if (!['queued', 'blocked', 'partial'].includes(r.status)) {
      throw new AppError('conflict', 'This investigation has already finished, so there is nothing to stop.');
    }
    r.status = 'canceled';
    r.finishedAt = ctx.now().toISOString();
    appendAudit(db, ctx, 'run.canceled', 'run', r.id, 'Stopped by the operator. Collected evidence was kept.');
    return r;
  });
}

export function getRun(ctx: Ctx, runId: string): InvestigationRun {
  return getOwned(ctx.store.snapshot().runs, runId, ctx.actor, 'Investigation');
}

export type RunDetail = {
  run: InvestigationRun;
  business: Business;
  sources: SourceRecord[];
  stages: StageState[];
  evidenceCounts: { total: number; needsReview: number; accepted: number; rejected: number };
  opportunityCount: number;
  rejections: Db['verifierRejections'];
  reportId: string | null;
  canRetry: boolean;
  duplicateOf: Business | null;
};

/** Run detail with the two review stages derived from current state. */
export function getRunDetail(ctx: Ctx, runId: string): RunDetail {
  const db = ctx.store.snapshot();
  const run = getOwned(db.runs, runId, ctx.actor, 'Investigation');
  const business = getOwned(db.businesses, run.businessId, ctx.actor, 'Business');
  const evidence = db.evidence.filter((e) => e.runId === runId && !e.supersededBy);
  const report = db.reports.find((r) => r.runId === runId) ?? null;
  const needsReview = evidence.filter((e) => e.verificationStatus === 'needs_review').length;
  const stages = run.stages.map((s) => ({ ...s }));
  const reviewStage = stages.find((s) => s.key === 'evidence_review')!;
  const reportStage = stages.find((s) => s.key === 'report')!;
  const finished = run.status === 'review_ready' || run.status === 'partial';
  if (finished && evidence.length > 0) {
    reviewStage.status = needsReview === 0 ? 'complete' : 'running';
    reviewStage.note = needsReview === 0 ? `All ${evidence.length} observation(s) have a review decision.` : `${needsReview} of ${evidence.length} observation(s) are waiting for your decision.`;
  } else if (finished) {
    reviewStage.status = 'not_checked';
    reviewStage.note = 'There are no observations to review.';
  } else {
    reviewStage.note = 'Starts when collection has finished.';
  }
  if (report && finished) {
    const approved = report.status === 'approved_internal' || report.status === 'approved_to_share';
    reportStage.status = approved ? 'complete' : 'running';
    reportStage.note = approved ? `Approved (${report.status === 'approved_to_share' ? 'owner version approved for sharing' : 'internal only'}).` : 'Draft. Internal only until you approve it.';
  } else {
    reportStage.note = 'Created when collection has finished.';
  }
  return {
    run,
    business,
    sources: db.sourceRecords.filter((s) => s.runId === runId).sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt)),
    stages,
    evidenceCounts: {
      total: evidence.length,
      needsReview,
      accepted: evidence.filter((e) => e.verificationStatus === 'accepted').length,
      rejected: evidence.filter((e) => e.verificationStatus === 'rejected').length,
    },
    opportunityCount: db.opportunities.filter((o) => o.runId === runId && o.status !== 'invalidated' && o.decision !== 'rejected').length,
    rejections: db.verifierRejections.filter((r) => r.runId === runId),
    reportId: report?.id ?? null,
    canRetry:
      run.status === 'partial' &&
      run.retriesUsed < ctx.config.maxRetries &&
      (db.sourceRecords.some((s) => s.runId === runId && s.retryable) || run.robots.status === 'unreachable'),
    duplicateOf: business.possibleDuplicateOf ? (db.businesses.find((b) => b.id === business.possibleDuplicateOf && b.ownerId === ctx.actor.userId) ?? null) : null,
  };
}

export function listRuns(ctx: Ctx): { run: InvestigationRun; business: Business }[] {
  const db = ctx.store.snapshot();
  return listOwned(db.runs, ctx.actor)
    .map((run) => ({ run, business: db.businesses.find((b) => b.id === run.businessId)! }))
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
}
