// Report views. Reports are computed from current evidence, never hand-written
// by an adapter or model. Two audiences:
//   internal - everything the operator needs to review
//   owner    - fail-closed: only accepted, public, PUBLIC_BUSINESS-backed claims
//
// Approval is bound to a content hash. If anything underneath changes, the
// approval is withdrawn automatically.

import { appendAudit, getOwned, listOwned, requireHuman, type Ctx } from '../context';
import { AppError } from '../errors';
import { newId, sha256, shortId } from '../ids';
import type { Business, Caveat, Confidence, Db, Evidence, InvestigationRun, Opportunity, Report, SourceRecord } from '../types';

export type SourceView = {
  label: string;
  url: string | null;
  accessStatus: SourceRecord['accessStatus'];
  accessDetail: string;
  retrievedAt: string;
  manual: boolean;
};

export type EvidenceView = {
  id: string;
  shortId: string;
  observation: string;
  excerpt: string | null;
  observedAt: string;
  confidence: Confidence;
  rationale: string;
  caveats: Caveat[];
  sensitivity: Evidence['sensitivity'];
  verificationStatus: Evidence['verificationStatus'];
  manual: boolean;
  stale: boolean;
  sources: SourceView[];
};

export type OpportunityView = {
  id: string;
  title: string;
  observedFact: string;
  interpretation: string;
  alternatives: string[];
  ownerQuestion: string;
  possibleFix: string;
  confidence: Confidence;
  caveats: Caveat[];
  status: Opportunity['status'];
  decision: Opportunity['decision'];
  decisionReason: string | null;
  evidence: EvidenceView[];
};

export type JourneyState = 'Not checked' | 'Checked; not found' | 'Access restricted' | 'Error' | 'Verified';
export type JourneyRow = { step: string; state: JourneyState; detail: string };

export type ReportView = {
  audience: 'internal' | 'owner';
  business: { displayName: string; city: string; state: string; domain: string | null; identity: string };
  synthetic: boolean;
  mode: InvestigationRun['mode'];
  runId: string;
  investigatedAt: string | null;
  executiveFinding: string;
  sources: SourceView[];
  journey: JourneyRow[];
  opportunities: OpportunityView[];
  unknowns: { question: string; reason: string }[];
  ownerQuestions: string[];
  possibleImprovements: string[];
  methodology: string[];
};

export type RedactionSummary = {
  opportunitiesIncluded: number;
  opportunitiesWithheld: { title: string; reason: string }[];
  evidenceWithheld: number;
  sourcesWithheld: number;
};

const IDENTITY_LABEL: Record<Business['identityStatus'], string> = {
  confirmed: 'Name and location matched the website',
  confirmed_by_operator: 'Confirmed manually by the operator',
  ambiguous: 'Ambiguous: needs operator review',
  unverified: 'Not verified',
};

function sourceView(r: SourceRecord): SourceView {
  return {
    label: r.sourceType === 'website' ? (r.sourceUrl ?? 'website') : 'Manually recorded observation',
    url: r.sourceUrl,
    accessStatus: r.accessStatus,
    accessDetail: r.accessDetail,
    retrievedAt: r.retrievedAt,
    manual: r.sourceType === 'manual_observation',
  };
}

function isStale(e: Evidence, now: Date, staleAfterDays: number): boolean {
  return new Date(e.observedAt).getTime() < now.getTime() - staleAfterDays * 86_400_000;
}

function evidenceView(e: Evidence, sources: Map<string, SourceRecord>, now: Date, staleAfterDays: number): EvidenceView {
  return {
    id: e.id,
    shortId: shortId(e.id),
    observation: e.observation,
    excerpt: e.supportingExcerpt,
    observedAt: e.observedAt,
    confidence: e.confidence,
    rationale: e.confidenceRationale,
    caveats: e.caveats,
    sensitivity: e.sensitivity,
    verificationStatus: e.verificationStatus,
    manual: e.dedupeKey.startsWith('manual:'),
    stale: isStale(e, now, staleAfterDays),
    sources: e.sourceRecordIds.map((id) => sources.get(id)).filter((r): r is SourceRecord => Boolean(r)).map(sourceView),
  };
}

/** Fail closed: anything not positively known to be shareable is excluded. */
export function isOwnerSafeEvidence(e: Evidence, sources: Map<string, SourceRecord>): boolean {
  if (e.sensitivity !== 'public') return false;
  if (e.verificationStatus !== 'accepted') return false;
  if (e.supersededBy) return false;
  if (e.identityMatchStatus !== 'confirmed') return false;
  if (e.evidenceType === 'instruction_like_text') return false;
  if (e.sourceRecordIds.length === 0) return false;
  return e.sourceRecordIds.every((id) => {
    const r = sources.get(id);
    return Boolean(r) && r!.permittedStorageClass === 'PUBLIC_BUSINESS' && r!.accessStatus === 'ok';
  });
}

function journey(evidence: Evidence[], websiteRecords: SourceRecord[], pending: (e: Evidence) => boolean, rejectedTypes: Set<Evidence['evidenceType']> = new Set(), noneDetail = 'No source for this step was inspected in this investigation.'): JourneyRow[] {
  const anyRestricted = websiteRecords.some((r) => r.accessStatus === 'restricted');
  const anyError = websiteRecords.some((r) => r.accessStatus === 'error' || r.accessStatus === 'unavailable');
  const anyOk = websiteRecords.some((r) => r.accessStatus === 'ok');
  const row = (step: string, types: Evidence['evidenceType'][]): JourneyRow => {
    const relevant = evidence.filter((e) => types.includes(e.evidenceType));
    const describe = (list: Evidence[]) => list.map((e) => `${e.observation}${pending(e) ? ' (awaiting review)' : ''}`).join(' ');
    const present = relevant.filter((e) => e.polarity !== 'absence');
    const absent = relevant.filter((e) => e.polarity === 'absence');
    if (present.length > 0) return { step, state: 'Verified', detail: describe(relevant) };
    if (absent.length > 0) return { step, state: 'Checked; not found', detail: describe(absent) };
    if (types.some((t) => rejectedTypes.has(t))) return { step, state: 'Not checked', detail: 'An observation for this step was not accepted in review, so nothing is asserted about it.' };
    if (!anyOk && anyRestricted) return { step, state: 'Access restricted', detail: 'The website refused access, so this step could not be observed. This says nothing about the business.' };
    if (anyRestricted) return { step, state: 'Access restricted', detail: 'Part of the website refused access, so this step could not be concluded.' };
    if (anyError) return { step, state: 'Error', detail: 'A page could not be retrieved, so this step could not be concluded. Retry the failed source.' };
    return { step, state: 'Not checked', detail: noneDetail };
  };
  return [
    { step: 'Discovery (search, AI answers)', state: 'Not checked', detail: 'Search and AI-search visibility were not sampled.' },
    row('Contact (phone, form)', ['phone_listed', 'contact_form']),
    row('Booking (online request or scheduling)', ['booking_link', 'phone_scheduling_statement']),
    row('After-hours availability', ['after_hours_statement', 'hours_listed']),
    row('Response and follow-up', ['customer_comment', 'owner_statement']),
  ];
}

const BASE_METHOD = [
  'Pages were read as HTML only. Content inserted by JavaScript after load was not seen.',
  'No forms were submitted, no calls were placed and no bookings were attempted.',
  '"Not found" always refers to the pages listed. It does not mean a feature does not exist.',
  'Comments recorded by hand are individual accounts. They do not show how often something happens.',
  'No revenue, conversion or lost-job estimate is made. The investigation has no owner-provided baseline.',
];

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'an unknown date';
}

function executiveFinding(business: Business, websiteRecords: SourceRecord[], opps: OpportunityView[], run: InvestigationRun): string {
  const ok = websiteRecords.filter((r) => r.accessStatus === 'ok').length;
  const failed = websiteRecords.length - ok;
  const scope =
    websiteRecords.length === 0
      ? `The website for ${business.displayName} was not inspected in this investigation.`
      : ok === 0
        ? `The website ${business.domain ?? ''} could not be inspected on ${day(run.startedAt)} (${failed} page(s) restricted or unavailable). This is not a finding about the business.`
        : `We inspected ${ok} page(s) of ${business.domain ?? 'the website'} on ${day(run.startedAt)}${failed > 0 ? `; ${failed} further page(s) could not be inspected` : ''}.`;
  if (opps.length === 0) {
    return `${scope} We have no evidence-backed observation to raise. That is a valid outcome, and it is not a statement that nothing could be improved.`;
  }
  return `${scope} ${opps.length} observation(s) may be worth a conversation with the owner: ${opps.map((o) => o.title).join('; ')}. Each is a hypothesis to check with the owner, not a conclusion.`;
}

function load(db: Db, runId: string) {
  const run = db.runs.find((r) => r.id === runId)!;
  const business = db.businesses.find((b) => b.id === run.businessId)!;
  const records = db.sourceRecords.filter((r) => r.runId === runId);
  const evidence = db.evidence.filter((e) => e.runId === runId && !e.supersededBy);
  const opportunities = db.opportunities.filter((o) => o.runId === runId);
  return { run, business, records, evidence, opportunities, sources: new Map(records.map((r) => [r.id, r])) };
}

function oppView(o: Opportunity, evidenceById: Map<string, Evidence>, sources: Map<string, SourceRecord>, now: Date, staleAfterDays: number): OpportunityView {
  return {
    id: o.id,
    title: o.title,
    observedFact: o.observedFact,
    interpretation: o.interpretation,
    alternatives: o.alternativeExplanations,
    ownerQuestion: o.ownerQuestion,
    possibleFix: o.possibleFix,
    confidence: o.confidence,
    caveats: o.caveats,
    status: o.status,
    decision: o.decision,
    decisionReason: o.decisionReason,
    evidence: o.evidenceIds.map((id) => evidenceById.get(id)).filter((e): e is Evidence => Boolean(e)).map((e) => evidenceView(e, sources, now, staleAfterDays)),
  };
}

export function buildInternalView(db: Db, runId: string, now: Date, staleAfterDays: number): ReportView {
  const { run, business, records, evidence, opportunities, sources } = load(db, runId);
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const live = opportunities.filter((o) => o.status !== 'invalidated' && o.decision !== 'rejected');
  const opps = live.map((o) => oppView(o, evidenceById, sources, now, staleAfterDays));
  const website = records.filter((r) => r.sourceType === 'website');
  const usable = evidence.filter((e) => e.verificationStatus !== 'rejected' && e.identityMatchStatus === 'confirmed');
  const method = [...BASE_METHOD, `Claims were proposed by "${run.modelVersion}" and checked by the claim verifier before display.`];
  if (business.synthetic) method.unshift('MOCK DATA: this report describes a fictional business built from synthetic fixtures. It is not evidence about any real company.');
  return {
    audience: 'internal',
    business: { displayName: business.displayName, city: business.city, state: business.state, domain: business.domain, identity: IDENTITY_LABEL[business.identityStatus] },
    synthetic: business.synthetic,
    mode: run.mode,
    runId,
    investigatedAt: run.startedAt,
    executiveFinding: executiveFinding(business, website, opps, run),
    sources: records.map(sourceView),
    journey: journey(usable, website, (e) => e.verificationStatus !== 'accepted', new Set(evidence.filter((e) => e.verificationStatus === 'rejected').map((e) => e.evidenceType))),
    opportunities: opps,
    unknowns: run.unknowns.map((u) => ({ question: u.question, reason: u.reason })),
    ownerQuestions: [...new Set(opps.map((o) => o.ownerQuestion))],
    possibleImprovements: [...new Set(opps.map((o) => o.possibleFix))],
    methodology: method,
  };
}

export function buildOwnerView(db: Db, runId: string, now: Date, staleAfterDays: number): { view: ReportView; redaction: RedactionSummary } {
  const { run, business, records, evidence, opportunities, sources } = load(db, runId);
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const safeEvidence = evidence.filter((e) => isOwnerSafeEvidence(e, sources));
  const safeIds = new Set(safeEvidence.map((e) => e.id));
  const included: Opportunity[] = [];
  const withheld: { title: string; reason: string }[] = [];
  for (const o of opportunities) {
    if (o.status === 'invalidated' || o.decision === 'rejected') continue;
    if (o.status !== 'supported') {
      withheld.push({ title: o.title, reason: 'Evidence has not all been accepted by the reviewer.' });
    } else if (o.decision !== 'accepted') {
      withheld.push({ title: o.title, reason: 'The reviewer has not accepted this opportunity.' });
    } else if (!o.evidenceIds.every((id) => safeIds.has(id))) {
      // The claim may rest on restricted material, so the whole claim is withheld.
      withheld.push({ title: o.title, reason: 'Relies on restricted, personal or non-public evidence.' });
    } else {
      included.push(o);
    }
  }
  const opps = included.map((o) => oppView(o, evidenceById, sources, now, staleAfterDays));
  const publicRecords = records.filter((r) => r.permittedStorageClass === 'PUBLIC_BUSINESS' && r.sourceType === 'website');
  const method = [...BASE_METHOD];
  if (business.synthetic) method.unshift('MOCK DATA: this report describes a fictional business built from synthetic fixtures. It is not evidence about any real company.');
  const view: ReportView = {
    audience: 'owner',
    business: { displayName: business.displayName, city: business.city, state: business.state, domain: business.domain, identity: IDENTITY_LABEL[business.identityStatus] },
    synthetic: business.synthetic,
    mode: run.mode,
    runId,
    investigatedAt: run.startedAt,
    executiveFinding: executiveFinding(business, publicRecords, opps, run),
    sources: publicRecords.map(sourceView),
    journey: journey(safeEvidence, publicRecords, () => false, new Set(evidence.filter((e) => !safeIds.has(e.id) && e.dedupeKey.startsWith('website:')).map((e) => e.evidenceType)), 'This report includes no observation for this step.'),
    opportunities: opps,
    unknowns: run.unknowns.map((u) => ({ question: u.question, reason: u.reason })),
    ownerQuestions: [...new Set(opps.map((o) => o.ownerQuestion))],
    possibleImprovements: [...new Set(opps.map((o) => o.possibleFix))],
    methodology: method,
  };
  return {
    view,
    redaction: {
      opportunitiesIncluded: opps.length,
      opportunitiesWithheld: withheld,
      evidenceWithheld: evidence.length - safeEvidence.length,
      sourcesWithheld: records.length - publicRecords.length,
    },
  };
}

// ---- Markdown export (owner view only) ------------------------------------

/** Neutralizes Markdown and HTML so source-derived text cannot inject links, images or script. */
export function mdEscape(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // ( ) and ! are harmless once [ and ] are escaped, so they stay readable.
    .replace(/([\\`*_{}[\]#+|~])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // encodeURIComponent leaves ( and ) alone, so encode by code point.
    return u.toString().replace(/[<>()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  } catch {
    return null;
  }
}

export function renderOwnerMarkdown(view: ReportView): string {
  if (view.audience !== 'owner') throw new AppError('forbidden', 'Only the owner-safe view can be exported.');
  const L: string[] = [];
  L.push(`# Investigation report: ${mdEscape(view.business.displayName)}`);
  if (view.synthetic) L.push('', '**MOCK DATA. Fictional business. Not evidence about any real company. Do not send.**');
  L.push('', `Location on record: ${mdEscape(`${view.business.city}, ${view.business.state}`)}  `);
  L.push(`Website: ${mdEscape(view.business.domain ?? 'none on record')}  `);
  L.push(`Identity check: ${mdEscape(view.business.identity)}  `);
  L.push(`Investigated: ${mdEscape(day(view.investigatedAt))} (UTC)`);
  L.push('', '## Summary', '', mdEscape(view.executiveFinding));
  L.push('', '## Scope and inspected sources', '');
  if (view.sources.length === 0) L.push('No public sources were inspected.');
  for (const s of view.sources) {
    const url = safeUrl(s.url);
    L.push(`- ${url ?? mdEscape(s.label)} — ${mdEscape(s.accessDetail)} — retrieved ${mdEscape(s.retrievedAt)}`);
  }
  L.push('', '## Observed customer journey', '');
  for (const j of view.journey) L.push(`- **${mdEscape(j.step)}:** ${mdEscape(j.state)}. ${mdEscape(j.detail)}`);
  L.push('', '## Findings', '');
  if (view.opportunities.length === 0) L.push('No findings are included in this report.');
  view.opportunities.forEach((o, i) => {
    L.push(`### ${i + 1}. ${mdEscape(o.title)}`, '');
    L.push(`**We observed:** ${mdEscape(o.observedFact)}`, '');
    L.push(`**Why it might matter (hypothesis):** ${mdEscape(o.interpretation)}`, '');
    L.push('**Other explanations:**');
    for (const a of o.alternatives) L.push(`- ${mdEscape(a)}`);
    L.push('', `**Question for you:** ${mdEscape(o.ownerQuestion)}`, '');
    L.push(`**Possible improvement:** ${mdEscape(o.possibleFix)}`, '');
    L.push(`**Confidence in the observation:** ${mdEscape(o.confidence)} (this is not an estimate of business impact)`, '');
    L.push('**Evidence:**');
    for (const e of o.evidence) {
      L.push(`- \`${e.shortId}\` ${mdEscape(e.observation)} Observed ${mdEscape(e.observedAt)}. ${mdEscape(e.rationale)}`);
      for (const s of e.sources) {
        const url = safeUrl(s.url);
        if (url) L.push(`  - Source: ${url}`);
      }
    }
    L.push('');
  });
  L.push('## What we could not verify', '');
  if (view.unknowns.length === 0) L.push('- How calls, voicemails and requests are handled inside the business. Only the owner can confirm this.');
  for (const u of view.unknowns) L.push(`- ${mdEscape(u.question)} ${mdEscape(u.reason)}`);
  L.push('', '## Method and limitations', '');
  for (const m of view.methodology) L.push(`- ${mdEscape(m)}`);
  L.push('');
  return L.join('\n');
}

// ---- Lifecycle ------------------------------------------------------------

export function hashView(view: ReportView): string {
  return sha256(JSON.stringify(view));
}

function reopen(db: Db, ctx: Ctx, report: Report, why: string): void {
  report.status = 'evidence_review';
  report.version += 1;
  report.approvedAt = null;
  report.approvedContentHash = null;
  report.sharedAt = null;
  report.sharedSnapshot = null;
  report.sharedContentHash = null;
  appendAudit(db, ctx, 'report.reopened', 'report', report.id, why, 'system');
  for (const draft of db.outreachDrafts.filter((d) => d.reportId === report.id && d.status === 'approved')) {
    draft.status = 'draft';
    draft.approvedAt = null;
    draft.approvalId = null;
    appendAudit(db, ctx, 'outreach.approval_withdrawn', 'outreach_draft', draft.id, 'Report changed after approval.', 'system');
  }
}

/** Called inside a transaction after anything that can change report content. */
export function syncReportAfterChange(db: Db, ctx: Ctx, runId: string): Report {
  const run = db.runs.find((r) => r.id === runId)!;
  let report = db.reports.find((r) => r.runId === runId);
  if (!report) {
    report = {
      id: newId('rep'),
      ownerId: run.ownerId,
      runId,
      businessId: run.businessId,
      version: 1,
      status: 'evidence_review',
      approvedAt: null,
      approvedContentHash: null,
      sharedAt: null,
      sharedSnapshot: null,
      sharedContentHash: null,
      createdAt: ctx.now().toISOString(),
    };
    db.reports.push(report);
    return report;
  }
  if (report.status === 'approved_internal' || report.status === 'approved_to_share') {
    const current = hashView(buildInternalView(db, runId, ctx.now(), ctx.config.staleAfterDays));
    if (current !== report.approvedContentHash) reopen(db, ctx, report, 'Evidence or opportunities changed after approval.');
  }
  return report;
}

export type ReportBundle = {
  report: Report;
  run: InvestigationRun;
  business: Business;
  internal: ReportView;
  internalHash: string;
  owner: ReportView;
  ownerMarkdown: string;
  ownerHash: string;
  redaction: RedactionSummary;
  blockers: string[];
};

function approvalBlockers(db: Db, runId: string): string[] {
  const run = db.runs.find((r) => r.id === runId)!;
  const out: string[] = [];
  if (!['review_ready', 'partial'].includes(run.status)) out.push(`The investigation is "${run.status}". It must finish (fully or partially) before a report can be approved.`);
  const pendingEvidence = db.evidence.filter((e) => e.runId === runId && !e.supersededBy && e.verificationStatus === 'needs_review').length;
  if (pendingEvidence > 0) out.push(`${pendingEvidence} observation(s) still need a review decision in the evidence desk.`);
  const pendingOpps = db.opportunities.filter((o) => o.runId === runId && o.status === 'supported' && o.decision === 'pending').length;
  if (pendingOpps > 0) out.push(`${pendingOpps} supported opportunity(ies) still need an accept or reject decision.`);
  return out;
}

export function getReportBundle(ctx: Ctx, reportId: string): ReportBundle {
  const db = ctx.store.snapshot();
  const report = getOwned(db.reports, reportId, ctx.actor, 'Report');
  const run = getOwned(db.runs, report.runId, ctx.actor, 'Investigation');
  const business = getOwned(db.businesses, report.businessId, ctx.actor, 'Business');
  const internal = buildInternalView(db, run.id, ctx.now(), ctx.config.staleAfterDays);
  const { view: owner, redaction } = buildOwnerView(db, run.id, ctx.now(), ctx.config.staleAfterDays);
  const ownerMarkdown = renderOwnerMarkdown(owner);
  return {
    report,
    run,
    business,
    internal,
    internalHash: hashView(internal),
    owner,
    ownerMarkdown,
    ownerHash: sha256(ownerMarkdown),
    redaction,
    blockers: approvalBlockers(db, run.id),
  };
}

export function listReports(ctx: Ctx): { report: Report; business: Business; run: InvestigationRun }[] {
  const db = ctx.store.snapshot();
  return listOwned(db.reports, ctx.actor)
    .map((report) => ({
      report,
      business: db.businesses.find((b) => b.id === report.businessId)!,
      run: db.runs.find((r) => r.id === report.runId)!,
    }))
    .sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt));
}

export function decideOpportunity(ctx: Ctx, opportunityId: string, decision: 'accepted' | 'rejected', reason: string): void {
  requireHuman(ctx.actor, 'Deciding on an opportunity');
  const why = reason.trim().slice(0, 300);
  if (decision === 'rejected' && why.length < 3) throw new AppError('validation', 'Give a short reason for rejecting this opportunity.');
  ctx.store.transact((db) => {
    const opp = getOwned(db.opportunities, opportunityId, ctx.actor, 'Opportunity');
    if (opp.status === 'invalidated') throw new AppError('conflict', 'This opportunity is no longer supported by its evidence.');
    if (decision === 'accepted' && opp.status !== 'supported') {
      throw new AppError('conflict', 'Accept all of its evidence in the evidence desk before accepting this opportunity.');
    }
    opp.decision = decision;
    opp.decisionReason = why || null;
    appendAudit(db, ctx, `opportunity.${decision}`, 'opportunity', opp.id, why || 'No reason given.');
    syncReportAfterChange(db, ctx, opp.runId);
  });
}

/** Internal approval. `expectedHash` binds the approval to the content the operator saw. */
export function approveReport(ctx: Ctx, reportId: string, expectedHash: string): Report {
  requireHuman(ctx.actor, 'Approving a report');
  return ctx.store.transact((db) => {
    const report = getOwned(db.reports, reportId, ctx.actor, 'Report');
    const blockers = approvalBlockers(db, report.runId);
    if (blockers.length > 0) throw new AppError('conflict', blockers.join(' '));
    const hash = hashView(buildInternalView(db, report.runId, ctx.now(), ctx.config.staleAfterDays));
    if (hash !== expectedHash) throw new AppError('conflict', 'The report changed after you opened it. Review it again before approving.');
    report.status = 'approved_internal';
    report.approvedAt = ctx.now().toISOString();
    report.approvedContentHash = hash;
    appendAudit(db, ctx, 'report.approved_internal', 'report', report.id, `Version ${report.version} approved for internal use.`);
    return report;
  });
}

/** Separate, explicit step: approve the exact owner-safe text for sharing. Nothing is sent or published. */
export function approveShare(ctx: Ctx, reportId: string, expectedOwnerHash: string): Report {
  requireHuman(ctx.actor, 'Approving a report for sharing');
  return ctx.store.transact((db) => {
    const report = getOwned(db.reports, reportId, ctx.actor, 'Report');
    if (report.status !== 'approved_internal') throw new AppError('conflict', 'Approve the report internally before approving the owner version.');
    const { view, redaction } = buildOwnerView(db, report.runId, ctx.now(), ctx.config.staleAfterDays);
    const markdown = renderOwnerMarkdown(view);
    const hash = sha256(markdown);
    if (hash !== expectedOwnerHash) throw new AppError('conflict', 'The owner version changed after you previewed it. Preview it again before approving.');
    report.status = 'approved_to_share';
    report.sharedAt = ctx.now().toISOString();
    report.sharedSnapshot = markdown;
    report.sharedContentHash = hash;
    appendAudit(
      db,
      ctx,
      'report.approved_to_share',
      'report',
      report.id,
      `Owner version approved. Included ${redaction.opportunitiesIncluded} finding(s); withheld ${redaction.opportunitiesWithheld.length} finding(s), ${redaction.evidenceWithheld} observation(s), ${redaction.sourcesWithheld} source(s).`,
    );
    return report;
  });
}

/** Returns the exact approved owner text. Recorded as an export; nothing leaves the machine. */
export function exportOwnerReport(ctx: Ctx, reportId: string): { filename: string; markdown: string } {
  requireHuman(ctx.actor, 'Exporting a report');
  return ctx.store.transact((db) => {
    const report = getOwned(db.reports, reportId, ctx.actor, 'Report');
    if (report.status !== 'approved_to_share' || !report.sharedSnapshot) {
      throw new AppError('approval_required', 'Only an owner version you have approved for sharing can be exported.');
    }
    appendAudit(db, ctx, 'report.exported', 'report', report.id, `Owner version ${report.version} exported as Markdown.`);
    return { filename: `owner-report-${report.id.slice(4, 12)}-v${report.version}.md`, markdown: report.sharedSnapshot };
  });
}
