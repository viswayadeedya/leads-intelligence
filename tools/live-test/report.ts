// Internal report for one live-test investigation, as Markdown.
// INTERNAL ONLY: it contains unreviewed observations, raw excerpts and
// diagnostics. It is not the owner-safe report and must not be sent to anyone.

import type { RequestLogEntry } from '@/lib/security/safe-fetch';
import { mdEscape } from '@/lib/services/reports';
import type { Db, Evidence, SourceRecord } from '@/lib/types';
import type { ApprovedBusiness } from './approvals';

export type LiveRunSummary = {
  label: string;
  runId: string;
  businessId: string;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  approvedHosts: string[];
  requestLog: RequestLogEntry[];
  wireRequests: number;
  identityConfirmedBy: 'site_text' | 'operator' | 'not_confirmed';
  limits: { maxPages: number; requestCap: number; timeoutMs: number; maxBytes: number; maxRedirects: number; minDelayMs: number; maxWireRequests: number };
};

const esc = (v: string | null | undefined) => mdEscape(v ?? '');
const urlOf = (r: SourceRecord) => r.sourceUrl ?? '(no address)';
/** The address the page actually came from, when a redirect moved it. */
const servedFrom = (r: SourceRecord): string => {
  const final = typeof r.queryContext.finalUrl === 'string' ? r.queryContext.finalUrl : null;
  if (!final) return '';
  if (final === r.sourceUrl) return 'same address';
  return `${final} (${r.queryContext.redirects ?? '?'} redirect(s)${final.startsWith('http://') ? '; UNENCRYPTED HTTP' : ''})`;
};

export function renderInternalMarkdown(db: Db, summary: LiveRunSummary, approved: ApprovedBusiness): string {
  const run = db.runs.find((r) => r.id === summary.runId)!;
  const business = db.businesses.find((b) => b.id === summary.businessId)!;
  const records = db.sourceRecords.filter((r) => r.runId === run.id).sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt));
  const byId = new Map(records.map((r) => [r.id, r]));
  const evidence = db.evidence.filter((e) => e.runId === run.id && !e.supersededBy);
  const opportunities = db.opportunities.filter((o) => o.runId === run.id && o.status !== 'invalidated');
  const rejections = db.verifierRejections.filter((r) => r.runId === run.id);
  const L: string[] = [];

  L.push(`# INTERNAL live-test report ${summary.label}: ${esc(business.displayName)}`);
  L.push('', '**Internal only. Unreviewed. Not for the business owner, not for outreach.** Every observation below still needs a human review decision in the evidence desk before it can be used for anything.');
  L.push('', '## 1. Business and identity', '');
  L.push(`- Name on record: ${esc(business.displayName)}`);
  L.push(`- Location on record: ${esc(`${business.city}, ${business.state}`)}`);
  L.push(`- Website on record: ${esc(business.domain)}`);
  L.push(`- Identity status: **${esc(business.identityStatus)}** (${summary.identityConfirmedBy === 'site_text' ? "confirmed from the site's own text" : summary.identityConfirmedBy === 'operator' ? "NOT confirmed by the site's text; confirmed by the operator in the approval record" : 'NOT confirmed'})`);
  if (business.identityNotes.length > 0) for (const note of business.identityNotes) L.push(`  - Identity check note: ${esc(note)}`);
  L.push(`- Why this business was chosen: ${esc(approved.selectionNote)}`);

  L.push('', '## 2. Scope of this investigation', '');
  L.push(`- Run: \`${run.id}\`, status **${run.status}**, mode ${run.mode}`);
  L.push(`- Started ${summary.startedAt}, finished ${summary.finishedAt} (${(summary.wallClockMs / 1000).toFixed(1)} s wall clock, including pauses between requests)`);
  L.push(`- Approved hostnames (exact): ${summary.approvedHosts.map((h) => `\`${h}\``).join(', ')}`);
  L.push(`- Pages requested by the investigation: ${run.requestsUsed} of ${run.requestCap} allowed. HTTP requests put on the wire, redirects included: ${summary.wireRequests} of ${summary.limits.maxWireRequests}.`);
  L.push(`- Limits: ${summary.limits.maxPages} pages per site, ${summary.limits.timeoutMs} ms per page, ${summary.limits.maxBytes} bytes per page, ${summary.limits.maxRedirects} redirects, ${summary.limits.minDelayMs} ms between requests.`);
  L.push(`- robots.txt: ${run.robots.status === 'ok' ? 'read and applied' : run.robots.status === 'none' ? 'none exists (HTTP 404 or 410); nothing was disallowed' : run.robots.status === 'unreachable' ? `its rules could not be determined (${run.robots.reason ?? 'reason not recorded'}), so NO page was requested` : 'not requested'}`);
  L.push('- Method: GET requests for HTML only. No forms submitted, no calls, no logins, no scripts run, no cookies kept.');

  L.push('', '## 3. Pages', '');
  L.push('| Page requested | Served from | Result | Detail | Retrieved (UTC) | Could not read in full because |', '|---|---|---|---|---|---|');
  for (const r of records.filter((x) => x.sourceType === 'website')) {
    const limits = (r.extracted?.readLimits ?? []).join(', ') || (r.accessStatus === 'ok' ? 'nothing noted' : 'not read');
    L.push(`| ${urlOf(r)} | ${servedFrom(r)} | ${r.accessStatus} | ${esc(r.accessDetail)} | ${r.retrievedAt} | ${esc(limits)} |`);
  }
  if (run.errorSummary.length > 0) {
    L.push('', 'Problems during the run:');
    for (const e of run.errorSummary) L.push(`- \`${e.code}\`: ${esc(e.message)}`);
  }
  for (const stage of run.stages) L.push(`- Stage ${stage.key}: **${stage.status}**. ${esc(stage.note)}`);

  L.push('', '## 4. Observations (evidence)', '');
  if (evidence.length === 0) L.push('No observation was recorded.');
  const order: Evidence['evidenceType'][] = ['phone_listed', 'contact_form', 'booking_link', 'phone_scheduling_statement', 'after_hours_statement', 'after_hours_negative', 'after_hours_mention', 'hours_listed', 'hours_conflict', 'stale_marker', 'instruction_like_text'];
  const sorted = [...evidence].sort((a, b) => order.indexOf(a.evidenceType) - order.indexOf(b.evidenceType));
  for (const e of sorted) {
    L.push(`### \`${e.id}\``, '');
    L.push(`- Type: ${e.evidenceType} (${e.polarity === 'absence' ? 'NOT FOUND on the pages listed' : e.polarity})`);
    L.push(`- Observation: ${esc(e.observation)}`);
    if (e.supportingExcerpt) L.push(`- Excerpt from the page (untrusted text, shown as data): "${esc(e.supportingExcerpt)}"`);
    L.push(`- Observed: ${e.observedAt}`);
    L.push(`- Review status: **${e.verificationStatus}**. Identity match: ${e.identityMatchStatus}. Privacy class: ${e.sensitivity}.`);
    L.push(`- Confidence: **${e.confidence}**. ${esc(e.confidenceRationale)}`);
    if (e.caveats.length > 0) L.push(`- Caveats: ${e.caveats.join(', ')}`);
    L.push('- Source pages:');
    for (const id of e.sourceRecordIds) {
      const r = byId.get(id);
      if (r) L.push(`  - ${servedFrom(r) === 'same address' || servedFrom(r) === '' ? urlOf(r) : servedFrom(r).replace(/ \(.*$/, '')} (retrieved ${r.retrievedAt}, ${r.accessStatus})`);
    }
    L.push('');
  }

  L.push('## 5. Unknowns and collection limits', '');
  if (run.unknowns.length === 0) L.push('- None recorded by the collector.');
  for (const u of run.unknowns) L.push(`- **${esc(u.question)}** ${esc(u.reason)}`);
  L.push('- Not tested at all: whether calls are answered, how voicemail and web requests are followed up, anything behind a login, anything drawn by scripts after the page loads.');
  L.push('- Not sampled: search results, review sites, social media.');

  L.push('', '## 6. Possible opportunities (hypotheses awaiting human review)', '');
  if (opportunities.length === 0) L.push('**None.** No claim was both proposed and accepted by the verifier. That is a valid outcome.');
  for (const o of opportunities) {
    L.push(`### ${esc(o.title)}`, '');
    L.push(`- Status: ${o.status}; reviewer decision: **${o.decision}**; written from: ${o.reasonedFrom ?? 'not recorded'}`);
    L.push(`- Observed: ${esc(o.observedFact)}`);
    L.push(`- Why it might matter (hypothesis, not established): ${esc(o.interpretation)}`);
    L.push(`- Other explanations: ${o.alternativeExplanations.map(esc).join(' | ')}`);
    L.push(`- Question for the owner: ${esc(o.ownerQuestion)}`);
    L.push(`- Possible fix (only if the owner confirms a gap): ${esc(o.possibleFix)}`);
    L.push(`- Confidence in the observation: ${o.confidence}. Evidence: ${o.evidenceIds.map((id) => `\`${id}\``).join(', ')}`);
    L.push('');
  }
  if (rejections.length > 0) {
    L.push('Claims the verifier rejected:');
    for (const r of rejections) L.push(`- \`${r.code}\` "${esc(r.proposalTitle)}": ${esc(r.message)}`);
  }

  L.push('', '## 7. Request log', '');
  L.push('| Time (UTC) | Address | Outcome | Detail | Bytes | ms | Requests on the wire |', '|---|---|---|---|---|---|---|');
  for (const entry of summary.requestLog) {
    L.push(`| ${entry.at} | ${entry.url} | ${entry.outcome} | ${esc(entry.detail)} | ${entry.bytes ?? ''} | ${entry.ms} | ${entry.wireRequests} |`);
  }
  L.push('', '## 8. What this report does not show', '');
  L.push('- It does not show that any call, form or request goes unanswered. Nothing was tested by contacting the business.');
  L.push('- "Not found" refers only to the HTML of the pages listed in section 3, on the date shown.');
  L.push('- No revenue, conversion or lost-customer figure is made or implied.');
  L.push('');
  return L.join('\n');
}
