// Turns per-page extracts into scoped observations. Pure function.
//
// Core rule (EVIDENCE_POLICY, "Reject 'absence' claim when collection failed or
// was blocked"): an absence observation is produced ONLY when every planned
// page was inspected successfully. Otherwise the question becomes an Unknown.

import { sha256 } from '../ids';
import type { Caveat, Confidence, Evidence, EvidenceType, PageExtract, Polarity, Sensitivity, SourceRecord, Unknown, UnknownTopic } from '../types';
import { classifyAvailabilitySentence, extractHoursStatements, hoursConflict } from './site-statements';

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

type HoursOf = NonNullable<PageExtract['hoursStatements']>[number];
type AvailabilityOf = NonNullable<PageExtract['availability']>[number];

/** The page's hours statements. Rows stored before statements were kept in full hold one excerpt; it is re-read here. */
function hoursOf(extract: PageExtract): HoursOf[] {
  if (extract.hoursStatements) return extract.hoursStatements;
  return extract.hours ? extractHoursStatements(extract.hours) : [];
}

/** The page's emergency and after-hours wording, classified. Older rows hold one unclassified excerpt. */
function availabilityOf(extract: PageExtract): AvailabilityOf[] {
  if (extract.availability) return extract.availability;
  if (!extract.afterHours) return [];
  const text = extract.afterHours.replace(/^…|…$/g, '');
  // An old excerpt is a window of text, not a sentence, so it is never promoted to "affirmative".
  const found = classifyAvailabilitySentence(text);
  return [{ kind: found && found.kind === 'negative' ? 'negative' : 'ambiguous', text: text.slice(0, 300), why: 'excerpt stored before statements were classified; re-inspect the page' }];
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
  // A page that arrived over plain HTTP could have been changed on the way; say so on the observation.
  const overPlainHttp = records.some((r) => typeof r.queryContext.finalUrl === 'string' && r.queryContext.finalUrl.startsWith('http://'));
  const caveats: Caveat[] = overPlainHttp && !extra.caveats.includes('unencrypted_http') ? [...extra.caveats, 'unencrypted_http'] : extra.caveats;
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
    caveats,
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
  const withPhoneScheduling = ok.filter((r) => r.extracted!.phoneScheduling);
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
  // --- published hours: every distinct statement, never a choice between them ---
  const pageCaveats: Caveat[] = staleRecord ? ['site_may_be_outdated'] : [];
  const quote = (text: string) => `"${text.replace(/\s+/g, ' ').trim().slice(0, 160)}"`;
  const onPages = (pages: SourceRecord[]) => `on ${pathsLabel(pages.map((r) => r.extracted!.path))}`;
  type SiteHours = { statement: HoursOf; pages: SourceRecord[] };
  const hoursById = new Map<string, SiteHours>();
  for (const r of ok) {
    for (const statement of hoursOf(r.extracted!)) {
      const id = `${statement.kind}|${statement.qualifier ?? ''}|${statement.key}`;
      const entry = hoursById.get(id);
      if (entry) entry.pages.push(r);
      else hoursById.set(id, { statement, pages: [r] });
    }
  }
  const siteHours = [...hoursById.values()];
  const officeHours = siteHours.filter((h) => h.statement.kind === 'office');
  const qualifiedHours = siteHours.filter((h) => h.statement.kind === 'qualified');
  const emergencyHours = siteHours.filter((h) => h.statement.kind === 'emergency');
  const describeHours = (h: SiteHours) => `${quote(h.statement.text)}${h.statement.qualifier ? `, labelled ${h.statement.qualifier}` : ''} (${onPages(h.pages)})`;
  const hoursLocator = (list: SiteHours[]) =>
    list.map((h) => `${h.statement.kind}${h.statement.qualifier ? ` (${h.statement.qualifier})` : ''} | ${h.statement.text} | pages: ${pathsLabel(h.pages.map((r) => r.extracted!.path))} | reads as: ${h.statement.key} | context: ${h.statement.context}`.slice(0, 600));
  const unionPages = (list: { pages: SourceRecord[] }[]) => ok.filter((r) => list.some((h) => h.pages.includes(r)));

  const publishedHours = [...officeHours, ...qualifiedHours];
  if (publishedHours.length > 0) {
    const observation =
      publishedHours.length === 1
        ? `Office hours are published: ${describeHours(publishedHours[0]!)}.`
        : `${publishedHours.length} different hours statements are published: ${publishedHours.map(describeHours).join('; ')}.`;
    evidence.push(
      candidate('hours_listed', 'presence', observation, publishedHours[0]!.statement.context, unionPages(publishedHours), {
        confidence: 'high',
        rationale: `${DIRECT} These are the site's own statements, quoted as written. Nothing here says which hours the business actually keeps.`,
        caveats: pageCaveats,
        locator: { hoursStatements: hoursLocator(publishedHours) },
      }),
    );
  }

  // Statements are compared only with statements of the same kind and label: office with
  // office, showroom with showroom. Emergency hours and seasonal or department hours are
  // expected to differ from office hours, so they are never treated as a contradiction of them.
  const conflicting = new Set<SiteHours>();
  for (const a of publishedHours) {
    for (const b of publishedHours) {
      if (a === b || a.statement.kind !== b.statement.kind || a.statement.qualifier !== b.statement.qualifier) continue;
      if (hoursConflict(a.statement as never, b.statement as never)) {
        conflicting.add(a);
        conflicting.add(b);
      }
    }
  }
  if (conflicting.size > 0) {
    const list = publishedHours.filter((h) => conflicting.has(h));
    evidence.push(
      candidate(
        'hours_conflict',
        'neutral',
        `The site publishes hours that differ for the same days: ${list.map(describeHours).join(' and ')}. Which one is correct was not determined.`,
        list.map((h) => h.statement.context).join(' ⟂ '),
        unionPages(list),
        {
          confidence: 'high',
          rationale: `${DIRECT} Both statements are on the site as quoted. This check cannot tell which is current, and the difference may have a reason it does not see (a second location, a department, an old page).`,
          caveats: pageCaveats,
          locator: { hoursStatements: hoursLocator(list) },
        },
      ),
    );
  }

  // --- emergency and after-hours wording: what the site says, in three separate bins ---
  type SiteWording = { kind: AvailabilityOf['kind']; text: string; why: string; pages: SourceRecord[] };
  const wordingById = new Map<string, SiteWording>();
  for (const r of ok) {
    for (const statement of availabilityOf(r.extracted!)) {
      const id = `${statement.kind}|${statement.text.toLowerCase()}`;
      const entry = wordingById.get(id);
      if (entry) entry.pages.push(r);
      else wordingById.set(id, { ...statement, pages: [r] });
    }
  }
  // Hours published for emergency or after-hours service are a statement of availability.
  for (const h of emergencyHours) {
    wordingById.set(`affirmative|hours|${h.statement.key}`, { kind: 'affirmative', text: h.statement.context, why: 'publishes hours for emergency or after-hours service', pages: h.pages });
  }
  const wording = [...wordingById.values()];
  const anyAvailabilityWording = wording.length > 0;
  const affirmative = wording.filter((w) => w.kind === 'affirmative');
  const negative = wording.filter((w) => w.kind === 'negative');
  const emergencyOffers = wording.filter((w) => w.kind === 'emergency_offer');
  const ambiguous = wording.filter((w) => w.kind === 'ambiguous');
  const describeWording = (list: SiteWording[]) =>
    `${list.slice(0, 3).map((w) => `${quote(w.text)} (${onPages(w.pages)})`).join('; ')}${list.length > 3 ? `; and ${list.length - 3} more` : ''}`;
  const wordingLocator = (list: SiteWording[]) => list.map((w) => `${w.kind} | ${w.text} | pages: ${pathsLabel(w.pages.map((r) => r.extracted!.path))} | read as: ${w.why}`.slice(0, 600));
  const NOT_TESTED = 'This is wording on the website. Whether calls are answered, at any hour, was not tested.';

  if (affirmative.length > 0) {
    evidence.push(
      candidate('after_hours_statement', 'presence', `The site states that service is available around the clock or outside office hours: ${describeWording(affirmative)}.`, affirmative[0]!.text, unionPages(affirmative), {
        confidence: 'high',
        rationale: `${DIRECT} ${NOT_TESTED}${negative.length > 0 ? ' Another statement on the site says the opposite; see the separate observation.' : ''}`,
        caveats: pageCaveats,
        locator: { availabilityStatements: wordingLocator(affirmative) },
      }),
    );
  }
  if (negative.length > 0) {
    evidence.push(
      candidate('after_hours_negative', 'neutral', `The site says emergency or after-hours service is not offered: ${describeWording(negative)}.`, negative[0]!.text, unionPages(negative), {
        confidence: 'medium',
        rationale: `${DIRECT} The wording was classified by pattern as a negative statement; read the quote before relying on it. ${NOT_TESTED}${affirmative.length > 0 ? ' Another statement on the site says the opposite; see the separate observation.' : ''}`,
        caveats: pageCaveats,
        locator: { availabilityStatements: wordingLocator(negative) },
      }),
    );
  }
  // Only when nothing clearer was found: wording that mentions the subject but does not
  // state availability. It is deliberately NOT evidence that the service is available.
  if (affirmative.length === 0 && (emergencyOffers.length > 0 || ambiguous.length > 0)) {
    const list = emergencyOffers.length > 0 ? emergencyOffers : ambiguous;
    const observation =
      emergencyOffers.length > 0
        ? `The site says emergency service is offered but does not say when it is available: ${describeWording(list)}.`
        : `The site uses emergency, 24-hour or after-hours wording without saying that such service is offered: ${describeWording(list)}.`;
    evidence.push(
      candidate('after_hours_mention', 'neutral', observation, list[0]!.text, unionPages(list), {
        confidence: 'low',
        rationale: `${DIRECT} The wording does not state availability outside office hours, so it is not counted as such. ${NOT_TESTED}`,
        caveats: pageCaveats,
        locator: { availabilityStatements: wordingLocator([...emergencyOffers, ...ambiguous]) },
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
    { type: 'after_hours_statement', present: anyAvailabilityWording, thing: 'statement about after-hours or emergency availability', question: 'Whether the website describes after-hours availability is unknown.' },
  ];
  // Pages stored before emergency wording was recorded in full were searched with a narrower
  // rule that is known to have missed wording. "Not found" cannot rest on them.
  const readWithOldRule = ok.filter((r) => r.extracted!.availability === undefined);
  for (const check of absenceChecks) {
    if (check.present) continue;
    const partlyRead = check.type === 'after_hours_statement' ? partlyReadAny : partlyReadEmbeds;
    const oldRule = check.type === 'after_hours_statement' ? readWithOldRule : [];
    if (complete && partlyRead.length === 0 && oldRule.length === 0) {
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
      if (oldRule.length > 0) why.push(`${oldRule.length} page(s) were read before this wording was searched for in full and have not been read again`);
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
