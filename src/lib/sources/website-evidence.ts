// Turns per-page extracts into scoped observations. Pure function.
//
// Core rule (EVIDENCE_POLICY, "Reject 'absence' claim when collection failed or
// was blocked"): an absence observation is produced ONLY when every planned
// page was inspected successfully. Otherwise the question becomes an Unknown.

import { sha256 } from '../ids';
import type { Caveat, Confidence, Evidence, EvidenceType, Polarity, Sensitivity, SourceRecord, Unknown, UnknownTopic } from '../types';

export type EvidenceCandidate = Pick<
  Evidence,
  | 'evidenceType'
  | 'polarity'
  | 'observation'
  | 'supportingExcerpt'
  | 'locator'
  | 'sourceRecordIds'
  | 'sensitivity'
  | 'confidence'
  | 'confidenceRationale'
  | 'caveats'
  | 'dedupeKey'
  | 'checksum'
>;

export type UnknownCandidate = Omit<Unknown, 'id'>;

const DIRECT = "Read directly from the HTML of the business's own website.";
const SAMPLED =
  'Direct observation, but limited to the pages inspected and to HTML as delivered. Content added by JavaScript, or on pages that were not inspected, would not be seen.';

function pathsLabel(paths: string[]): string {
  return paths.join(', ');
}

function candidate(
  evidenceType: EvidenceType,
  polarity: Polarity,
  observation: string,
  excerpt: string | null,
  records: SourceRecord[],
  extra: { confidence: Confidence; rationale: string; caveats: Caveat[]; sensitivity?: Sensitivity; locator?: Evidence['locator'] },
): EvidenceCandidate {
  const sourceRecordIds = records.map((r) => r.id);
  const pages = records.map((r) => r.extracted?.path ?? r.sourceUrl ?? '');
  return {
    evidenceType,
    polarity,
    observation,
    supportingExcerpt: excerpt ? excerpt.slice(0, 240) : null,
    locator: { pagesInspected: pages, ...(extra.locator ?? {}) },
    sourceRecordIds,
    sensitivity: extra.sensitivity ?? 'public',
    confidence: extra.confidence,
    confidenceRationale: extra.rationale,
    caveats: extra.caveats,
    dedupeKey: `website:${evidenceType}`,
    checksum: sha256(JSON.stringify([evidenceType, polarity, observation, excerpt, sourceRecordIds])),
  };
}

export function aggregateWebsiteEvidence(input: {
  records: SourceRecord[];
  plannedPaths: string[] | null;
  budgetExhausted: boolean;
  nowYear: number;
}): { evidence: EvidenceCandidate[]; unknowns: UnknownCandidate[] } {
  const website = input.records.filter((r) => r.sourceType === 'website');
  const ok = website.filter((r) => r.accessStatus === 'ok' && r.extracted);
  const failed = website.filter((r) => r.accessStatus !== 'ok');
  const evidence: EvidenceCandidate[] = [];
  const unknowns: UnknownCandidate[] = [];
  if (ok.length === 0) {
    if (failed.length > 0) {
      unknowns.push({
        question: 'How customers can contact or book through the website is unknown.',
        reason: `The website could not be inspected (${failed.map((r) => `${pathOf(r)}: ${r.accessDetail}`).join('; ')}). This is not a finding about the business.`,
        sourceRecordIds: failed.map((r) => r.id),
        kind: 'website_not_inspected',
        topic: null,
        inspectedCount: 0,
        unreachedPlannedCount: 0,
        budgetExhausted: input.budgetExhausted,
      });
    }
    return { evidence, unknowns };
  }

  const inspectedPaths = ok.map((r) => r.extracted!.path);
  const planned = input.plannedPaths ?? [];
  const missingPlanned = planned.filter((p) => !website.some((r) => pathOf(r) === p));
  const complete = failed.length === 0 && missingPlanned.length === 0 && !input.budgetExhausted;
  // Pages that were fetched but could not be read in full. An embedded widget only
  // hides forms and schedulers; the other limits hide anything.
  const limitsOf = (r: SourceRecord) => r.extracted!.readLimits ?? [];
  const partlyReadAny = ok.filter((r) => limitsOf(r).some((l) => !l.startsWith('embedded:')));
  const partlyReadEmbeds = ok.filter((r) => limitsOf(r).length > 0);
  const describeLimits = (pages: SourceRecord[]) =>
    pages
      .map((r) => `${r.extracted!.path}: ${limitsOf(r).map((l) => (l.startsWith('embedded:') ? `embeds content from ${l.slice(9)}` : l === 'thin_content' ? 'almost no text in the HTML (probably drawn by scripts)' : 'too long to read in full')).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`)
      .join('; ');

  const staleRecord = ok.find((r) => r.extracted!.copyrightYear !== null && r.extracted!.copyrightYear <= input.nowYear - 2);
  const siteCaveats: Caveat[] = staleRecord ? ['html_only', 'site_may_be_outdated'] : ['html_only'];
  const m = ok.length;

  // --- presence observations -------------------------------------------
  const withPhone = ok.filter((r) => r.extracted!.phones.length > 0);
  if (withPhone.length > 0) {
    const phone = withPhone[0]!.extracted!.phones[0]!;
    evidence.push(
      candidate(
        'phone_listed',
        'presence',
        `A phone number (${phone}) is shown on ${withPhone.length} of ${m} inspected pages (${pathsLabel(withPhone.map((r) => r.extracted!.path))}).`,
        phone,
        withPhone,
        { confidence: 'high', rationale: DIRECT, caveats: staleRecord ? ['site_may_be_outdated'] : [] },
      ),
    );
  }

  const withBooking = ok.filter((r) => r.extracted!.bookingLinks.length > 0);
  const withForm = ok.filter((r) => r.extracted!.contactFormFieldCounts.length > 0);
  const withAfterHours = ok.filter((r) => r.extracted!.afterHours);
  const withPhoneScheduling = ok.filter((r) => r.extracted!.phoneScheduling);
  const withHours = ok.filter((r) => r.extracted!.hours);
  const withInstruction = ok.filter((r) => r.extracted!.instructionLike);

  if (withBooking.length > 0) {
    const first = withBooking[0]!;
    const link = first.extracted!.bookingLinks[0]!;
    evidence.push(
      candidate('booking_link', 'presence', `A link labelled "${link.text}" was found on ${first.extracted!.path}.`, link.text, withBooking, {
        confidence: 'high',
        rationale: `${DIRECT} The link target was not followed or submitted.`,
        caveats: staleRecord ? ['site_may_be_outdated'] : [],
        locator: { linkHref: link.href.slice(0, 300) },
      }),
    );
  }
  if (withForm.length > 0) {
    const first = withForm[0]!;
    const fields = first.extracted!.contactFormFieldCounts[0]!;
    evidence.push(
      candidate('contact_form', 'presence', `A contact form with ${fields} input fields was found on ${first.extracted!.path}. The form was not submitted.`, null, withForm, {
        confidence: 'high',
        rationale: DIRECT,
        caveats: staleRecord ? ['site_may_be_outdated'] : [],
      }),
    );
  }
  if (withAfterHours.length > 0) {
    const first = withAfterHours[0]!;
    evidence.push(
      candidate('after_hours_statement', 'presence', `The text on ${first.extracted!.path} mentions after-hours or emergency availability.`, first.extracted!.afterHours, withAfterHours, {
        confidence: 'high',
        rationale: `${DIRECT} This is the site's own statement; whether calls are actually answered was not tested.`,
        caveats: staleRecord ? ['site_may_be_outdated'] : [],
      }),
    );
  }
  if (withPhoneScheduling.length > 0) {
    const first = withPhoneScheduling[0]!;
    evidence.push(
      candidate('phone_scheduling_statement', 'presence', `The text on ${first.extracted!.path} tells visitors to call to schedule.`, first.extracted!.phoneScheduling, withPhoneScheduling, {
        confidence: 'high',
        rationale: DIRECT,
        caveats: staleRecord ? ['site_may_be_outdated'] : [],
      }),
    );
  }
  if (withHours.length > 0) {
    const first = withHours[0]!;
    evidence.push(
      candidate('hours_listed', 'presence', `Office hours are stated on ${first.extracted!.path}.`, first.extracted!.hours, withHours, {
        confidence: 'high',
        rationale: DIRECT,
        caveats: staleRecord ? ['site_may_be_outdated'] : [],
      }),
    );
  }
  if (staleRecord) {
    evidence.push(
      candidate('stale_marker', 'neutral', `The footer copyright year on ${staleRecord.extracted!.path} reads ${staleRecord.extracted!.copyrightYear}.`, null, [staleRecord], {
        confidence: 'high',
        rationale: `${DIRECT} An old footer year suggests, but does not prove, that the site is not maintained.`,
        caveats: [],
      }),
    );
  }
  if (withInstruction.length > 0) {
    const first = withInstruction[0]!;
    evidence.push(
      candidate(
        'instruction_like_text',
        'neutral',
        `Text that reads like instructions to an automated agent was found on ${first.extracted!.path}. It was stored as page content only; nothing was done in response.`,
        first.extracted!.instructionLike,
        withInstruction,
        { confidence: 'high', rationale: DIRECT, caveats: [], sensitivity: 'restricted' },
      ),
    );
  }

  // --- absence observations or unknowns --------------------------------
  const absenceChecks: { type: UnknownTopic; present: boolean; thing: string; question: string }[] = [
    { type: 'booking_link', present: withBooking.length > 0, thing: 'booking or appointment-request link', question: 'Whether the website offers online booking is unknown.' },
    { type: 'contact_form', present: withForm.length > 0, thing: 'contact form', question: 'Whether the website has a contact form is unknown.' },
    { type: 'after_hours_statement', present: withAfterHours.length > 0, thing: 'statement about after-hours or emergency availability', question: 'Whether the website describes after-hours availability is unknown.' },
  ];
  for (const check of absenceChecks) {
    if (check.present) continue;
    const partlyRead = check.type === 'after_hours_statement' ? partlyReadAny : partlyReadEmbeds;
    if (complete && partlyRead.length === 0) {
      evidence.push(
        candidate(check.type, 'absence', `No ${check.thing} was found in the HTML of the ${m} pages inspected (${pathsLabel(inspectedPaths)}).`, null, ok, {
          confidence: 'medium',
          rationale: SAMPLED,
          caveats: siteCaveats,
        }),
      );
    } else {
      const why: string[] = [];
      if (failed.length > 0) why.push(`${failed.length} page(s) could not be inspected (${failed.map((r) => `${pathOf(r)}: ${r.accessDetail}`).join('; ')})`);
      if (missingPlanned.length > 0) why.push(`${missingPlanned.length} planned page(s) were not reached (${pathsLabel(missingPlanned)})`);
      if (input.budgetExhausted) why.push('the request budget for this run was reached');
      if (partlyRead.length > 0) why.push(`${partlyRead.length} page(s) could only be read in part (${describeLimits(partlyRead)})`);
      unknowns.push({
        question: check.question,
        reason: `Not found on the ${m} page(s) that were inspected, but ${why.join(' and ')}. "Not found on inspected pages" does not mean it does not exist.`,
        sourceRecordIds: failed.map((r) => r.id),
        kind: 'feature_not_concluded',
        topic: check.type,
        inspectedCount: m,
        unreachedPlannedCount: missingPlanned.length,
        budgetExhausted: input.budgetExhausted,
        partiallyReadCount: partlyRead.length,
      });
    }
  }

  return { evidence, unknowns };
}

export function pathOf(record: SourceRecord): string {
  if (record.extracted) return record.extracted.path;
  try {
    return record.sourceUrl ? new URL(record.sourceUrl).pathname || '/' : '';
  } catch {
    return record.sourceUrl ?? '';
  }
}
