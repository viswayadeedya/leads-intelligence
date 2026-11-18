// Outreach: draft, review, copy. THIS BUILD CANNOT SEND ANYTHING.
// There is no email, form, call or posting code path. "Mark manually sent"
// only records that the human operator sent it themselves, and requires a
// single-use approval bound to the exact text, recipient, action and expiry.

import { appendAudit, getOwned, listOwned, requireHuman, type Ctx } from '../context';
import { AppError } from '../errors';
import { newId, randomToken, sha256 } from '../ids';
import type { Business, Db, OutreachDraft, Report } from '../types';
import { buildOwnerView } from './reports';

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /[$€£]\s?\d|\d\s?%|\b\d[\d,.]*\s?(?:dollars|percent)\b/i, why: 'a dollar or percentage figure' },
  { re: /\b(?:losing|lose|lost|costing you|missing out on)\b[^.]{0,40}\b(?:customers?|leads?|revenue|money|jobs?|business|sales|calls?)\b/i, why: 'a claim that the business is losing customers or money' },
  { re: /\bguarantee/i, why: 'a guarantee' },
  { re: /\b(?:act now|limited time|last chance|urgent)\b/i, why: 'pressure or urgency language' },
  { re: /\b(?:our clients|other clients|case study|we helped)\b/i, why: 'a reference to client results that this tool cannot substantiate' },
];

/** Returns the first rule the text breaks, or null. Applied to generated text and to every edit. */
export function outreachLanguageProblem(text: string): string | null {
  for (const rule of FORBIDDEN) if (rule.re.test(text)) return rule.why;
  return null;
}

export function draftContentHash(draft: Pick<OutreachDraft, 'subject' | 'body'>, recipient: string): string {
  return sha256(JSON.stringify(['outreach_manual_send', recipient, draft.subject, draft.body]));
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'recently';
}

/** Draft from ONE accepted, owner-safe finding of an approved report. */
export function createOutreachDraft(ctx: Ctx, reportId: string, opportunityId: string): OutreachDraft {
  requireHuman(ctx.actor, 'Creating an outreach draft');
  return ctx.store.transact((db) => {
    const report = getOwned(db.reports, reportId, ctx.actor, 'Report');
    if (report.status !== 'approved_internal' && report.status !== 'approved_to_share') {
      throw new AppError('approval_required', 'Approve the report before drafting outreach. Drafts are only built from approved findings.');
    }
    const business = getOwned(db.businesses, report.businessId, ctx.actor, 'Business');
    const { view } = buildOwnerView(db, report.runId, ctx.now(), ctx.config.staleAfterDays);
    const opp = view.opportunities.find((o) => o.id === opportunityId);
    if (!opp) {
      throw new AppError('conflict', 'Outreach can only reference a finding that is accepted and safe to show the owner.');
    }
    const existing = db.outreachDrafts.find((d) => d.reportId === report.id && d.opportunityId === opp.id && d.ownerId === ctx.actor.userId);
    if (existing) return existing;

    const fact = opp.observedFact.charAt(0).toLowerCase() + opp.observedFact.slice(1);
    const subject = `A question about how customers reach ${business.displayName}`;
    const body = [
      'Hello,',
      '',
      `I looked at the public pages of ${business.domain ?? 'your website'} on ${day(view.investigatedAt)}. One thing I noticed: ${fact}`,
      '',
      `I can't tell from the outside whether this matters for you. ${opp.alternatives[0] ?? ''}`.trim(),
      '',
      `So, a question rather than a pitch: ${opp.ownerQuestion}`,
      '',
      'I wrote down exactly what I checked and what I could not verify. I am happy to send it over if it would be useful.',
      '',
      'If this is not relevant, no reply is needed and I will not follow up.',
      '',
      '[Your name]',
      '[Your business and contact details]',
    ].join('\n');
    const problem = outreachLanguageProblem(`${subject}\n${body}`);
    if (problem) throw new AppError('conflict', `The generated draft contained ${problem} and was discarded.`);

    const draft: OutreachDraft = {
      id: newId('out'),
      ownerId: ctx.actor.userId,
      businessId: business.id,
      reportId: report.id,
      reportVersion: report.version,
      opportunityId: opp.id,
      channel: 'email',
      subject,
      body,
      status: 'draft',
      approvedAt: null,
      approvalId: null,
      copiedAt: null,
      sentAt: null,
      createdAt: ctx.now().toISOString(),
    };
    db.outreachDrafts.push(draft);
    appendAudit(db, ctx, 'outreach.draft_created', 'outreach_draft', draft.id, 'Draft created from an approved finding. Nothing was sent.');
    return draft;
  });
}

export function saveOutreachDraft(ctx: Ctx, draftId: string, subject: string, body: string): OutreachDraft {
  requireHuman(ctx.actor, 'Editing an outreach draft');
  const s = subject.replace(/[\r\n]+/g, ' ').trim();
  const b = body.replace(/\r\n/g, '\n').trim();
  if (s.length < 3 || s.length > 150) throw new AppError('validation', 'The subject must be between 3 and 150 characters.');
  if (b.length < 20 || b.length > 4000) throw new AppError('validation', 'The message must be between 20 and 4000 characters.');
  const problem = outreachLanguageProblem(`${s}\n${b}`);
  if (problem) throw new AppError('validation', `The draft contains ${problem}. Outreach may only mention what was actually observed.`);
  return ctx.store.transact((db) => {
    const draft = getOwned(db.outreachDrafts, draftId, ctx.actor, 'Outreach draft');
    if (draft.status === 'sent_manual') throw new AppError('conflict', 'This draft is recorded as sent and can no longer be edited.');
    const changed = draft.subject !== s || draft.body !== b;
    draft.subject = s;
    draft.body = b;
    if (changed && draft.status === 'approved') {
      // Approval covers exact text only.
      draft.status = 'draft';
      draft.approvedAt = null;
      draft.approvalId = null;
      appendAudit(db, ctx, 'outreach.approval_withdrawn', 'outreach_draft', draft.id, 'Draft edited after approval.');
    }
    if (changed) appendAudit(db, ctx, 'outreach.draft_edited', 'outreach_draft', draft.id, 'Draft text edited.');
    return draft;
  });
}

function recipientOf(business: Business): string {
  return `${business.displayName} <${business.domain ?? 'no website on record'}>`;
}

/**
 * Explicit operator approval of the exact draft text. Returns a one-time token
 * that is shown once and stored only as a hash.
 */
export function approveOutreach(ctx: Ctx, draftId: string, expectedContentHash: string): { draft: OutreachDraft; approvalToken: string } {
  requireHuman(ctx.actor, 'Approving outreach');
  return ctx.store.transact((db) => {
    const draft = getOwned(db.outreachDrafts, draftId, ctx.actor, 'Outreach draft');
    if (draft.status === 'sent_manual') throw new AppError('conflict', 'This draft is already recorded as sent.');
    const business = getOwned(db.businesses, draft.businessId, ctx.actor, 'Business');
    const report = getOwned(db.reports, draft.reportId, ctx.actor, 'Report');
    if (report.status !== 'approved_internal' && report.status !== 'approved_to_share') {
      throw new AppError('approval_required', 'The report is no longer approved. Review and approve it again first.');
    }
    if (report.version !== draft.reportVersion) {
      throw new AppError('conflict', 'The report changed after this draft was written. Check the draft against the current report, then save it again.');
    }
    const recipient = recipientOf(business);
    const hash = draftContentHash(draft, recipient);
    if (hash !== expectedContentHash) throw new AppError('conflict', 'The draft changed after you opened it. Review it again before approving.');
    const problem = outreachLanguageProblem(`${draft.subject}\n${draft.body}`);
    if (problem) throw new AppError('validation', `The draft contains ${problem}.`);
    const token = randomToken();
    const approval = {
      id: newId('apr'),
      ownerId: ctx.actor.userId,
      action: 'outreach_manual_send' as const,
      targetId: draft.id,
      recipient,
      contentHash: hash,
      tokenHash: sha256(token),
      expiresAt: new Date(ctx.now().getTime() + ctx.config.approvalTtlMinutes * 60_000).toISOString(),
      usedAt: null,
      createdAt: ctx.now().toISOString(),
    };
    db.approvals.push(approval);
    draft.status = 'approved';
    draft.approvedAt = approval.createdAt;
    draft.approvalId = approval.id;
    appendAudit(db, ctx, 'outreach.approved', 'outreach_draft', draft.id, `Approved exact text for ${recipient}. Expires ${approval.expiresAt}. Nothing was sent.`);
    return { draft, approvalToken: token };
  });
}

/** Validates and consumes an approval. Exported so every outbound-type action must pass through it. */
export function consumeApproval(db: Db, ctx: Ctx, input: { action: 'outreach_manual_send'; targetId: string; recipient: string; contentHash: string; token: string }): void {
  requireHuman(ctx.actor, 'An outbound action');
  const tokenHash = sha256(input.token);
  const approval = db.approvals.find((a) => a.tokenHash === tokenHash && a.ownerId === ctx.actor.userId);
  const refuse = (why: string): never => {
    appendAudit(db, ctx, 'approval.refused', 'outreach_draft', input.targetId, why, 'system');
    throw new AppError('approval_required', `Not approved: ${why}`);
  };
  if (!approval) return refuse('no matching approval was found.');
  if (approval.usedAt) return refuse('this approval was already used.');
  if (new Date(approval.expiresAt).getTime() < ctx.now().getTime()) return refuse('the approval has expired. Approve the draft again.');
  if (approval.action !== input.action || approval.targetId !== input.targetId) return refuse('the approval is for a different action or draft.');
  if (approval.recipient !== input.recipient) return refuse('the approval is for a different recipient.');
  if (approval.contentHash !== input.contentHash) return refuse('the text changed after it was approved.');
  approval.usedAt = ctx.now().toISOString();
}

/** Records that the operator sent the message themselves. The app sends nothing. */
export function markSentManually(ctx: Ctx, draftId: string, approvalToken: string): OutreachDraft {
  requireHuman(ctx.actor, 'Recording outreach as sent');
  // The refusal audit entry must persist even though the call fails, so the
  // check runs in its own transaction and the error is rethrown afterwards.
  let failure: AppError | null = null;
  const result = ctx.store.transact((db) => {
    const draft = getOwned(db.outreachDrafts, draftId, ctx.actor, 'Outreach draft');
    const business = getOwned(db.businesses, draft.businessId, ctx.actor, 'Business');
    if (business.synthetic) {
      failure = new AppError('conflict', 'This is a fictional business from the synthetic examples. Its draft cannot be recorded as sent.');
      return draft;
    }
    if (draft.status !== 'approved') {
      appendAudit(db, ctx, 'approval.refused', 'outreach_draft', draft.id, 'draft is not approved.', 'system');
      failure = new AppError('approval_required', 'Approve this exact draft before recording it as sent.');
      return draft;
    }
    const recipient = recipientOf(business);
    try {
      consumeApproval(db, ctx, { action: 'outreach_manual_send', targetId: draft.id, recipient, contentHash: draftContentHash(draft, recipient), token: approvalToken });
    } catch (e) {
      if (e instanceof AppError) {
        failure = e;
        return draft;
      }
      throw e;
    }
    draft.status = 'sent_manual';
    draft.sentAt = ctx.now().toISOString();
    appendAudit(db, ctx, 'outreach.marked_sent_manually', 'outreach_draft', draft.id, 'Operator recorded that they sent this themselves.');
    return draft;
  });
  if (failure) throw failure;
  return result;
}

/** Copying is allowed at any time and is logged as copied, not sent. */
export function logDraftCopied(ctx: Ctx, draftId: string): void {
  requireHuman(ctx.actor, 'Copying a draft');
  ctx.store.transact((db) => {
    const draft = getOwned(db.outreachDrafts, draftId, ctx.actor, 'Outreach draft');
    draft.copiedAt = ctx.now().toISOString();
    appendAudit(db, ctx, 'outreach.draft_copied', 'outreach_draft', draft.id, 'Draft copied to clipboard. Not sent.');
  });
}

export type OutreachItem = { draft: OutreachDraft; business: Business; report: Report; contentHash: string; recipient: string; observation: string | null; reportCurrent: boolean };

export function listOutreach(ctx: Ctx): OutreachItem[] {
  const db = ctx.store.snapshot();
  return listOwned(db.outreachDrafts, ctx.actor)
    .map((draft) => {
      const business = db.businesses.find((b) => b.id === draft.businessId)!;
      const report = db.reports.find((r) => r.id === draft.reportId)!;
      const recipient = recipientOf(business);
      const opp = db.opportunities.find((o) => o.id === draft.opportunityId);
      return {
        draft,
        business,
        report,
        recipient,
        contentHash: draftContentHash(draft, recipient),
        observation: opp ? opp.observedFact : null,
        reportCurrent: report.version === draft.reportVersion && (report.status === 'approved_internal' || report.status === 'approved_to_share'),
      };
    })
    .sort((a, b) => b.draft.createdAt.localeCompare(a.draft.createdAt));
}
