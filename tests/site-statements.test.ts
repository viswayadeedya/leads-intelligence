// Review findings 1, 2 and 4 on the live-evidence branch:
//   1. every published hours statement is kept, with its pages; contradictions are
//      reported, never resolved; emergency, seasonal and department hours are not
//      contradictions of office hours;
//   2. wording about emergency or after-hours service is sorted into affirmative,
//      emergency offer without hours, negative and ambiguous; only an explicit
//      statement of availability becomes positive evidence;
//   4. website observations stay website observations: no claim about missed
//      calls, lost leads, conversion or revenue can rest on them.
//
// All page text here is made up. The "business C" case reproduces the SHAPE of
// what was found on a real site (two closing times on two pages); real
// businesses are not named in this repository.

import { describe, expect, it } from 'vitest';
import type { Proposal } from '@/lib/reasoning/reasoner';
import { verifyProposal, type VerifierContext } from '@/lib/reasoning/verifier';
import { createBusiness } from '@/lib/services/businesses';
import { addManualEvidence } from '@/lib/services/evidence';
import { startInvestigation, toExtract } from '@/lib/services/investigations';
import { buildOwnerView } from '@/lib/services/reports';
import { extractPage } from '@/lib/sources/html-extract';
import { classifyAvailabilitySentence, extractAvailabilityStatements, extractHoursStatements, hoursConflict } from '@/lib/sources/site-statements';
import type { PageTransport } from '@/lib/sources/transport';
import { aggregateWebsiteEvidence } from '@/lib/sources/website-evidence';
import type { Evidence, SourceRecord } from '@/lib/types';
import { activeEv, liveOpps, makeCtx, NOW, runGolden } from './helpers';

const HOST = 'acme-heating.example.invalid';
const doc = (body: string) => `<!doctype html><html><head><title>Acme Heating</title></head><body>${body}</body></html>`;

/** Records as the investigation would store them, built from page bodies. */
function site(pages: Record<string, string>): SourceRecord[] {
  return Object.entries(pages).map(([path, body], i) => {
    const url = `https://${HOST}${path}`;
    return {
      id: `src_${i}`,
      ownerId: 'usr_a',
      runId: 'run_1',
      businessId: 'biz_1',
      sourceType: 'website',
      sourceUrl: url,
      provider: 'test',
      retrievedAt: `2026-11-18T12:00:0${i}.000Z`,
      accessStatus: 'ok',
      accessDetail: 'HTTP 200',
      permittedStorageClass: 'PUBLIC_BUSINESS',
      queryContext: { path, finalUrl: url, redirects: 0 },
      checksum: null,
      notes: '',
      attempts: 1,
      retryable: false,
      extracted: toExtract(path, extractPage(doc(body), url)),
      synthetic: true,
    } satisfies SourceRecord;
  });
}
const aggregate = (pages: Record<string, string>) => aggregateWebsiteEvidence({ records: site(pages), plannedPaths: Object.keys(pages).filter((p) => p !== '/'), budgetExhausted: false, nowYear: 2026 });
const ofType = (result: ReturnType<typeof aggregate>, type: Evidence['evidenceType']) => result.evidence.filter((e) => e.evidenceType === type);
const pathsOf = (pages: Record<string, string>, ids: string[]) => site(pages).filter((r) => ids.includes(r.id)).map((r) => r.extracted!.path);

const FOOTER = '<footer><p>Acme Heating, 410 Sample Street, Lowell, MI 49331. (616) 555-0142. Mon-Fri 9am - 5pm</p></footer>';

describe('finding 1: published office hours', () => {
  describe('reading one statement', () => {
    it.each([
      ['Mon-Fri 9am - 5pm', 'mon 09:00-17:00; tue 09:00-17:00; wed 09:00-17:00; thu 09:00-17:00; fri 09:00-17:00'],
      ['MONDAY - FRIDAY 8:30AM TO 4PM', 'mon 08:30-16:00; tue 08:30-16:00; wed 08:30-16:00; thu 08:30-16:00; fri 08:30-16:00'],
      ['Monday - Friday: 7:30am - 4:00pm Saturday - Sunday: Closed', 'mon 07:30-16:00; tue 07:30-16:00; wed 07:30-16:00; thu 07:30-16:00; fri 07:30-16:00; sat closed; sun closed'],
      ['Weekdays 8 - 5pm', 'mon 08:00-17:00; tue 08:00-17:00; wed 08:00-17:00; thu 08:00-17:00; fri 08:00-17:00'],
      ['Sat 1 - 5pm', 'sat 13:00-17:00'],
      ['Mon, Wed & Fri 9am-noon', 'mon 09:00-12:00; wed 09:00-12:00; fri 09:00-12:00'],
      ['Tues. thru Thurs. 10 a.m. to 6 p.m.', 'tue 10:00-18:00; wed 10:00-18:00; thu 10:00-18:00'],
      ['Sunday by appointment only', 'sun by appointment'],
    ])('%s', (text, key) => {
      const found = extractHoursStatements(`Office hours: ${text}.`);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'office', qualifier: null, key });
      expect(found[0]!.text).toContain(text.slice(0, 12));
    });

    it.each(['We open at 9 and close at 5', 'Rated 9 - 5 by customers on Monday', 'Mon 12-14 units installed', 'Call Monday for a quote', 'Model F-96 runs 8 to 10 years'])('does not read "%s" as hours', (text) => {
      expect(extractHoursStatements(text)).toEqual([]);
    });
  });

  it("business C's reported conflict: two closing times on two pages are both kept, with their pages, and neither is chosen", () => {
    const pages = {
      '/': `<h1>Acme Heating</h1><p>Furnace repair.</p>${FOOTER}`,
      '/contact': `<h1>Contact</h1><p>info@acme-heating.example.invalid (616) 555-0142 MONDAY - FRIDAY 8:30AM TO 4PM</p>${FOOTER}`,
      '/services': `<h1>Services</h1><p>Furnaces and air conditioners.</p>${FOOTER}`,
    };
    const result = aggregate(pages);

    const listed = ofType(result, 'hours_listed');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.observation).toBe('2 different hours statements are published: "Mon-Fri 9am - 5pm" (on /, /contact, /services); "MONDAY - FRIDAY 8:30AM TO 4PM" (on /contact).');
    expect(pathsOf(pages, listed[0]!.sourceRecordIds)).toEqual(['/', '/contact', '/services']);
    const statements = listed[0]!.locator.hoursStatements as string[];
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('pages: /, /contact, /services');
    expect(statements[0]).toContain('reads as: mon 09:00-17:00');
    expect(statements[1]).toContain('pages: /contact');
    expect(statements[1]).toContain('reads as: mon 08:30-16:00');
    expect(statements[1]).toContain('context: ');

    const conflict = ofType(result, 'hours_conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]).toMatchObject({ polarity: 'neutral', confidence: 'high' });
    expect(conflict[0]!.observation).toContain('"Mon-Fri 9am - 5pm"');
    expect(conflict[0]!.observation).toContain('"MONDAY - FRIDAY 8:30AM TO 4PM"');
    expect(conflict[0]!.observation).toContain('Which one is correct was not determined.');
    expect(conflict[0]!.confidenceRationale).toContain('cannot tell which is current');
    expect(pathsOf(pages, conflict[0]!.sourceRecordIds)).toEqual(['/', '/contact', '/services']);
    // Nothing anywhere says which schedule is right, or what happens to callers.
    const all = JSON.stringify(result.evidence);
    expect(all).not.toMatch(/correct hours are|actually open|actually closes|the real hours|is wrong|is outdated/i);
    expect(all).not.toMatch(/missed|lost|unanswered|revenue|conversion/i);
  });

  it('consistent schedules written differently on several pages are one statement and no conflict', () => {
    const result = aggregate({
      '/': '<p>Acme Heating, Lowell, MI. Hours: Mon-Fri 9am-5pm</p>',
      '/contact': '<p>Office hours Monday – Friday: 9:00 AM to 5:00 PM</p>',
      '/about': '<p>Open Mon - Fri 9 a.m. - 5 p.m.</p>',
    });
    const listed = ofType(result, 'hours_listed');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.observation).toMatch(/^Office hours are published: "Mon-Fri 9am-5pm" \(on \/, \/contact, \/about\)\.$/);
    expect(ofType(result, 'hours_conflict')).toEqual([]);
  });

  it('several day ranges in one statement on one page are one schedule, not a conflict', () => {
    const text = 'Hours: Mon-Fri 8am-5pm, Sat 9am-12pm, Sun Closed';
    const [statement, ...rest] = extractHoursStatements(text);
    expect(rest).toEqual([]);
    expect(statement!.days).toMatchObject({ mon: '08:00-17:00', fri: '08:00-17:00', sat: '09:00-12:00', sun: 'closed' });
    const result = aggregate({ '/': `<p>Acme Heating, Lowell, MI. ${text}</p>` });
    expect(ofType(result, 'hours_listed')).toHaveLength(1);
    expect(ofType(result, 'hours_conflict')).toEqual([]);
  });

  it('two different schedules on the SAME page are both kept and reported as a conflict on that page', () => {
    const pages = { '/': '<header><p>Acme Heating, Lowell, MI. Open Mon-Fri 8am-5pm</p></header><main><p>We repair furnaces and air conditioners for homeowners across the county.</p></main><footer><p>Hours: Mon-Fri 9am-4pm</p></footer>' };
    const result = aggregate(pages);
    expect((ofType(result, 'hours_listed')[0]!.locator.hoursStatements as string[]).length).toBe(2);
    const conflict = ofType(result, 'hours_conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.observation).toContain('(on /)');
  });

  it('a statement that adds a day does not contradict one that is silent about that day', () => {
    const result = aggregate({ '/': '<p>Acme Heating, Lowell, MI. Hours: Mon-Fri 8am-5pm</p>', '/contact': '<p>Hours: Mon-Fri 8am-5pm, Sat 9am-1pm</p>' });
    expect(ofType(result, 'hours_listed')[0]!.observation).toMatch(/^2 different hours statements are published/);
    expect(ofType(result, 'hours_conflict')).toEqual([]);
    expect(hoursConflict({ days: { sat: 'closed' } }, { days: { sat: '09:00-13:00' } })).toBe(true);
    expect(hoursConflict({ days: { mon: '08:00-17:00' } }, { days: { sat: '09:00-13:00' } })).toBe(false);
  });

  it('office hours and 24-hour emergency service are different things, not a contradiction', () => {
    const pages = {
      '/': '<p>Acme Heating, Lowell, MI. Office hours: Mon-Fri 8am-4pm. We also offer 24 hour emergency service.</p>',
      '/emergency': '<h1>Emergency service</h1><p>Emergency hours: Sat-Sun 8am-8pm</p><p>Open 24 Hours for no-heat calls.</p>',
    };
    const result = aggregate(pages);
    expect(ofType(result, 'hours_conflict')).toEqual([]);
    const listed = ofType(result, 'hours_listed');
    expect(listed).toHaveLength(1);
    // only the office hours are "office hours"
    expect(listed[0]!.observation).toBe('Office hours are published: "Mon-Fri 8am-4pm" (on /).');
    // the emergency hours and the 24-hour statements are availability statements
    const availability = ofType(result, 'after_hours_statement');
    expect(availability).toHaveLength(1);
    expect(availability[0]!.polarity).toBe('presence');
    expect(JSON.stringify(availability[0]!.locator)).toContain('Sat-Sun 8am-8pm');
    expect(JSON.stringify(availability[0]!.locator)).toContain('24 hour emergency service');
  });

  it('"24-Hour Emergency Service. Office hours: ..." is office hours; "Emergency hours: ..." is not', () => {
    expect(extractHoursStatements('24-Hour Emergency Service. Office hours: Mon-Fri 8am-5pm')[0]).toMatchObject({ kind: 'office' });
    expect(extractHoursStatements('24/7 emergency line Office Hours Mon-Fri 8am-5pm')[0]).toMatchObject({ kind: 'office' });
    expect(extractHoursStatements('Emergency hours: Sat-Sun 8am-8pm')[0]).toMatchObject({ kind: 'emergency' });
    expect(extractHoursStatements('After-hours service: Mon-Fri 5pm-10pm')[0]).toMatchObject({ kind: 'emergency' });
    expect(extractHoursStatements('On-call technician Sat 8am-6pm')[0]).toMatchObject({ kind: 'emergency' });
  });

  it('seasonal and department hours are kept, labelled, and not compared with office hours', () => {
    const pages = {
      '/': '<p>Acme Heating, Lowell, MI. Office hours: Mon-Fri 8am-5pm</p>',
      '/showroom': '<p>Showroom: Mon-Sat 10am-6pm</p>',
      '/summer': '<p>Summer hours: Mon-Fri 7am-3pm</p>',
      '/parts': '<p>Parts counter Mon-Fri 7am-4pm</p>',
    };
    const result = aggregate(pages);
    expect(ofType(result, 'hours_conflict')).toEqual([]);
    const observation = ofType(result, 'hours_listed')[0]!.observation;
    expect(observation).toMatch(/^4 different hours statements are published/);
    expect(observation).toContain('"Mon-Sat 10am-6pm", labelled showroom (on /showroom)');
    expect(observation).toContain('labelled seasonal (summer) (on /summer)');
    expect(observation).toContain('labelled parts counter (on /parts)');
  });

  it('two statements with the SAME department label that disagree are a conflict within that department', () => {
    const result = aggregate({ '/': '<p>Acme Heating, Lowell, MI. Showroom: Mon-Sat 10am-6pm</p>', '/visit': '<p>Showroom Mon-Sat 10am-5pm</p>' });
    const conflict = ofType(result, 'hours_conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.observation).toContain('labelled showroom');
  });

  it('a row stored before statements were kept in full is still read, from its one excerpt', () => {
    const records = site({ '/': '<p>Acme Heating, Lowell, MI.</p>' });
    records[0]!.extracted = { ...records[0]!.extracted!, hoursStatements: undefined, hours: '…Lowell, MI 49331 Mon-Fri 9am - 5pm info…', availability: undefined, afterHours: '…offer 24 hour emergency service. Give us…' };
    const result = aggregateWebsiteEvidence({ records, plannedPaths: [], budgetExhausted: false, nowYear: 2026 });
    expect(result.evidence.find((e) => e.evidenceType === 'hours_listed')!.observation).toContain('"Mon-Fri 9am - 5pm"');
    // an old excerpt is a window of text, not a sentence: it is never promoted to a positive statement
    expect(result.evidence.find((e) => e.evidenceType === 'after_hours_statement')).toBeUndefined();
    expect(result.evidence.find((e) => e.evidenceType === 'after_hours_mention')).toBeDefined();
  });
});

describe('finding 2: emergency and after-hours wording', () => {
  const kind = (sentence: string) => classifyAvailabilitySentence(sentence)?.kind ?? null;

  it.each([
    'We also offer 24 hour emergency service.',
    '24-Hour Emergency Service',
    'Open 24 Hours',
    'Our team of experts is available 24/7 to handle any emergency service.',
    'After-hours service available.',
    'Call us day or night for furnace repairs.',
    'Emergency service nights and weekends.',
    'Technicians on call around the clock.',
    // negation words that do not negate the offer
    "Don't wait: call our 24/7 emergency line.",
    'No job too small. 24/7 emergency service.',
    'We never close: 24/7 service.',
    "We can't promise same-day visits, but our 24-hour emergency line is always answered.",
  ])('affirmative: %s', (sentence) => {
    expect(extractAvailabilityStatements(sentence).map((s) => s.kind)).toContain('affirmative');
  });

  it.each(['From emergency HVAC service to new installations, we are ready to help.', 'Emergency Repairs', 'We offer emergency furnace repair.', 'Emergency service is available.'])('an emergency offer with no hours is its own kind, not availability: %s', (sentence) => {
    expect(kind(sentence)).toBe('emergency_offer');
  });

  it.each([
    'We do not offer 24/7 emergency service.',
    "We don't have 24-hour service.",
    'No after-hours calls.',
    'No emergency service on weekends.',
    'Emergency service is not available.',
    'Emergency service is not available on weekends.',
    'We are not a 24-hour company.',
    'Sorry, we no longer provide emergency repairs.',
    "We don't do emergency calls.",
    'Closed nights and weekends.',
    'After-hours service is unavailable in this area.',
    'We are unable to offer after-hours appointments.',
  ])('negative: %s', (sentence) => {
    expect(kind(sentence)).toBe('negative');
  });

  it.each([
    'In an emergency, call 911.',
    'What to do in a heating emergency',
    'Is your furnace an emergency?',
    'Do you offer 24/7 service?',
    'Use the emergency heat setting on your thermostat.',
    'Know where your emergency shut-off switch is.',
    '5 signs of a furnace emergency',
    'Avoid a mid-winter emergency with a fall tune-up.',
    'Tips for preventing an AC emergency.',
    "Don't wait for an emergency.",
    'No emergency is too small.',
    'Please leave a message after hours.',
    'Emergency service available during business hours.',
    '24-hour emergency service for maintenance plan members only.',
    'After-hours visits by appointment.',
    'We do not offer 24/7 service, but emergency calls are returned the next morning.',
    'Our thermostats hold a 24 hour schedule.',
    'We respond to all service calls within 24 hours.',
    'We require 24 hour notice to cancel a service call.',
    'Most repairs are finished in 24 hours or less.',
    '24/7',
    'Day or night.',
    'Emergencies happen.',
  ])('ambiguous, never positive: %s', (sentence) => {
    expect(kind(sentence)).toBe('ambiguous');
  });

  it('text that does not touch the subject yields nothing', () => {
    expect(extractAvailabilityStatements('Furnace repair and seasonal maintenance. Office open Monday to Friday. Call for a quote.')).toEqual([]);
  });

  it('an explicit statement of availability becomes positive evidence that quotes it and names its page', () => {
    const pages = { '/': '<p>Acme Heating, Lowell, MI.</p>', '/services': '<p>We also offer 24 hour emergency service.</p>' };
    const result = aggregate(pages);
    const positive = ofType(result, 'after_hours_statement');
    expect(positive).toHaveLength(1);
    expect(positive[0]).toMatchObject({ polarity: 'presence', confidence: 'high' });
    expect(positive[0]!.observation).toBe('The site states that service is available around the clock or outside office hours: "We also offer 24 hour emergency service." (on /services).');
    expect(positive[0]!.confidenceRationale).toContain('Whether calls are answered, at any hour, was not tested.');
    expect(pathsOf(pages, positive[0]!.sourceRecordIds)).toEqual(['/services']);
    expect(ofType(result, 'after_hours_negative')).toEqual([]);
    expect(ofType(result, 'after_hours_mention')).toEqual([]);
  });

  const neverPositive: [string, string, Evidence['evidenceType']][] = [
    ['a negated statement', 'We do not offer 24/7 emergency service.', 'after_hours_negative'],
    ['"no after-hours calls"', 'Please note: no after-hours calls.', 'after_hours_negative'],
    ['an emergency offer with no hours (the wording once missed on business C)', 'From emergency HVAC service to new installations, we are ready to help.', 'after_hours_mention'],
    ['safety advice', 'In an emergency, call 911 and leave the building.', 'after_hours_mention'],
    ['a blog headline', '5 signs of a furnace emergency', 'after_hours_mention'],
    ['a question', 'Do you offer 24/7 service?', 'after_hours_mention'],
    ['a conditional offer', '24-hour emergency service for maintenance plan members only.', 'after_hours_mention'],
    ['service limited to business hours', 'Emergency service available during business hours.', 'after_hours_mention'],
    ['a thermostat feature', 'Our thermostats hold a 24 hour schedule.', 'after_hours_mention'],
  ];
  it.each(neverPositive)('%s produces no positive availability evidence, and no "not found" either', (_label, sentence, expectedType) => {
    const result = aggregate({ '/': `<p>Acme Heating, Lowell, MI.</p><p>${sentence}</p>`, '/contact': '<p>Call (616) 555-0142.</p>' });
    expect(ofType(result, 'after_hours_statement')).toEqual([]);
    const found = ofType(result, expectedType);
    expect(found).toHaveLength(1);
    expect(found[0]!.polarity).toBe('neutral');
    expect(found[0]!.observation).toContain(sentence.slice(0, 40));
    // the page DID say something about the subject, so "no statement was found" would be false too
    expect(result.evidence.filter((e) => e.polarity === 'absence').map((e) => e.evidenceType)).not.toContain('after_hours_statement');
    expect(result.unknowns.filter((u) => u.topic === 'after_hours_statement')).toEqual([]);
  });

  it('the wording of each kind of observation says exactly what was and was not stated', () => {
    const offer = ofType(aggregate({ '/': '<p>Acme Heating, Lowell, MI. From emergency HVAC service to new installations, we are ready to help.</p>' }), 'after_hours_mention')[0]!;
    expect(offer.observation).toMatch(/^The site says emergency service is offered but does not say when it is available: /);
    expect(offer.confidence).toBe('low');
    expect(offer.confidenceRationale).toContain('does not state availability outside office hours, so it is not counted as such');
    const info = ofType(aggregate({ '/': '<p>Acme Heating, Lowell, MI. In an emergency, call 911.</p>' }), 'after_hours_mention')[0]!;
    expect(info.observation).toMatch(/^The site uses emergency, 24-hour or after-hours wording without saying that such service is offered: /);
    const denied = ofType(aggregate({ '/': '<p>Acme Heating, Lowell, MI. We do not offer 24/7 emergency service.</p>' }), 'after_hours_negative')[0]!;
    expect(denied.observation).toMatch(/^The site says emergency or after-hours service is not offered: /);
    expect(denied.confidenceRationale).toContain('read the quote before relying on it');
  });

  it('a site that says yes on one page and no on another yields both observations and picks neither', () => {
    const result = aggregate({ '/': '<p>Acme Heating, Lowell, MI. 24-Hour Emergency Service</p>', '/faq': '<p>We do not offer 24/7 emergency service.</p>' });
    expect(ofType(result, 'after_hours_statement')).toHaveLength(1);
    expect(ofType(result, 'after_hours_negative')).toHaveLength(1);
    expect(ofType(result, 'after_hours_statement')[0]!.confidenceRationale).toContain('Another statement on the site says the opposite');
    expect(ofType(result, 'after_hours_negative')[0]!.confidenceRationale).toContain('Another statement on the site says the opposite');
  });

  it('a page stored under the older, narrower rule cannot support "not found": it is an unknown', () => {
    const records = site({ '/': '<p>Acme Heating, Lowell, MI. Furnace repair.</p>', '/contact': '<p>Call (616) 555-0142.</p>' });
    records[1]!.extracted = { ...records[1]!.extracted!, availability: undefined, afterHours: null };
    const result = aggregateWebsiteEvidence({ records, plannedPaths: ['/contact'], budgetExhausted: false, nowYear: 2026 });
    expect(result.evidence.filter((e) => e.evidenceType === 'after_hours_statement')).toEqual([]);
    const unknown = result.unknowns.find((u) => u.topic === 'after_hours_statement')!;
    expect(unknown.kind).toBe('feature_not_concluded');
    expect(unknown.reason).toContain('1 page(s) were read before this wording was searched for in full and have not been read again');
    // the other absence checks do not depend on that rule and are unaffected
    expect(result.evidence.find((e) => e.evidenceType === 'booking_link')).toMatchObject({ polarity: 'absence' });
  });

  it('when nothing at all is said, and every page was read, the absence is still reported as before', () => {
    const result = aggregate({ '/': '<p>Acme Heating, Lowell, MI. Furnace repair.</p>', '/contact': '<p>Call (616) 555-0142.</p>' });
    expect(result.evidence.find((e) => e.evidenceType === 'after_hours_statement')).toMatchObject({ polarity: 'absence' });
  });
});

describe('finding 4: website observations are not operational claims', () => {
  const PAGES: Record<string, string> = {
    '/': `<nav><a href="/contact">Contact</a> <a href="/services">Services</a></nav><h1>Acme Heating</h1><p>Furnace repair in Lowell, MI. Call (616) 555-0142.</p><p>From emergency HVAC service to new installations, we are ready to help.</p>${FOOTER}`,
    '/contact': `<h1>Contact</h1><p>MONDAY - FRIDAY 8:30AM TO 4PM</p><form><input name="n"><input type="email" name="e"><textarea name="m"></textarea></form>${FOOTER}`,
    '/services': `<h1>Services</h1><p>Furnaces and air conditioners.</p>${FOOTER}`,
  };
  const transport: PageTransport = {
    id: 'test-pages',
    synthetic: true,
    costCentsPerRequest: 0,
    canHandle: (host) => host === HOST,
    async fetchPage(url) {
      const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
      const body = PAGES[path];
      if (!body) return { kind: 'unavailable', reason: 'http_404', httpStatus: 404, retryable: false };
      const html = doc(body);
      return { kind: 'ok', finalUrl: url, httpStatus: 200, contentType: 'text/html', body: html, redirectChain: [], bytes: html.length };
    },
  };
  async function investigated() {
    const ctx = makeCtx({ transport });
    const business = createBusiness(ctx, { displayName: 'Acme Heating', domain: HOST, city: 'Lowell', state: 'MI' });
    const run = await startInvestigation(ctx, { businessId: business.id });
    return { ctx, run, business, db: ctx.store.snapshot() };
  }
  const OPERATIONAL = /\b(?:missed|lost|unanswered|dropped|abandoned)\b|\bvoicemail\b|\brevenue\b|\bconversions?\b|\bleads?\b|\bresponse time\b/i;

  it('through the whole pipeline: exact source addresses, timestamps, caveats and needs_review are preserved', async () => {
    const { run, db } = await investigated();
    expect(run.status).toBe('review_ready');
    const evidence = activeEv(db, run.id);
    expect(evidence.map((e) => e.evidenceType).sort()).toEqual(['after_hours_mention', 'booking_link', 'contact_form', 'hours_conflict', 'hours_listed', 'phone_listed']);
    const records = new Map(db.sourceRecords.filter((r) => r.runId === run.id).map((r) => [r.id, r]));
    for (const e of evidence) {
      expect(e.verificationStatus, e.evidenceType).toBe('needs_review');
      expect(e.identityMatchStatus).toBe('confirmed');
      expect(Array.isArray(e.caveats)).toBe(true);
      expect(e.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(e.sourceRecordIds.length, e.evidenceType).toBeGreaterThan(0);
      for (const id of e.sourceRecordIds) {
        const record = records.get(id)!;
        expect(record.sourceUrl).toMatch(new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/`));
        expect(record.queryContext.finalUrl).toBe(record.sourceUrl);
        expect(record.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(record.accessStatus).toBe('ok');
      }
    }
    const conflict = evidence.find((e) => e.evidenceType === 'hours_conflict')!;
    expect(conflict.sourceRecordIds.map((id) => records.get(id)!.sourceUrl).sort()).toEqual([`https://${HOST}/`, `https://${HOST}/contact`, `https://${HOST}/services`]);
    // the absence observation carries its scope caveat
    expect(evidence.find((e) => e.evidenceType === 'booking_link')).toMatchObject({ polarity: 'absence', caveats: ['html_only'] });
  });

  it('no observation, rationale, unknown or proposed claim says anything about calls, leads, conversion or revenue', async () => {
    const texts: string[] = [];
    const mine = await investigated();
    for (const e of activeEv(mine.db, mine.run.id)) texts.push(e.observation, e.confidenceRationale);
    for (const key of ['baseline-phone-only', 'outdated-site', 'phone-scheduling', 'contact-form-deeper', 'booking-page-403', 'flaky-timeout', 'robots-disallow']) {
      const ctx = makeCtx();
      const { run } = await runGolden(ctx, key);
      const db = ctx.store.snapshot();
      for (const e of activeEv(db, run.id).filter((x) => x.dedupeKey.startsWith('website:'))) texts.push(e.observation, e.confidenceRationale);
      for (const u of db.runs.find((r) => r.id === run.id)!.unknowns) texts.push(u.question, u.reason);
      // claims proposed from website evidence alone
      for (const o of liveOpps(db, run.id).filter((x) => x.evidenceIds.every((id) => db.evidence.find((e) => e.id === id)!.dedupeKey.startsWith('website:')))) {
        texts.push(o.title, o.observedFact, o.interpretation);
      }
    }
    expect(texts.length).toBeGreaterThan(40);
    // "whether calls are answered ... was not tested" is a statement of what is NOT known, and is allowed
    const offenders = texts.filter((t) => OPERATIONAL.test(t.replace(/Whether calls are (?:actually )?answered[^.]*was not tested\./g, '')));
    expect(offenders).toEqual([]);
  });

  it('the new observations do not turn into opportunities, and nothing reaches the owner view without review', async () => {
    const { run, db } = await investigated();
    // A phone number and a contact form are present, so the one website rule does not fire;
    // a conflict in published hours and an emergency mention are not, by themselves, claims.
    expect(liveOpps(db, run.id)).toEqual([]);
    const { view } = buildOwnerView(db, run.id, NOW, 180);
    expect(view.opportunities).toEqual([]);
    expect(JSON.stringify(view.journey)).not.toContain('8:30AM');
  });

  describe('the verifier', () => {
    async function setup() {
      const { ctx, run, business, db } = await investigated();
      const evidence = () => activeEv(ctx.store.snapshot(), run.id);
      const vctx = (): VerifierContext => {
        const snap = ctx.store.snapshot();
        const records = snap.sourceRecords.filter((r) => r.runId === run.id);
        return { business, runId: run.id, evidenceById: new Map(evidence().map((e) => [e.id, e])), sourceRecordsById: new Map(records.map((r) => [r.id, r])), runSourceRecords: records, now: NOW, staleAfterDays: 180 };
      };
      const conflictId = db.evidence.find((e) => e.runId === run.id && e.evidenceType === 'hours_conflict')!.id;
      const claim = (over: Partial<Proposal> = {}): Proposal => ({
        title: 'Two different office hours are published',
        observed_fact: 'The contact page and the footer state different office hours: one says 8:30AM to 4PM and the other 9am to 5pm.',
        evidence_ids: [conflictId],
        interpretation: 'A caller may not know when the office is open.',
        alternative_explanations: ['One of the two statements may simply be out of date.'],
        owner_question: 'Which hours are current?',
        possible_fix: 'Only if the owner confirms which is right: show the same hours on every page.',
        confidence: 'high',
        ...over,
      });
      return { ctx, run, vctx, claim };
    }

    it('accepts a claim that stays with what the pages say', async () => {
      const { vctx, claim } = await setup();
      expect(verifyProposal(claim(), vctx())).toMatchObject({ ok: true });
    });

    const OPERATIONAL_CLAIMS: [string, Partial<Proposal>][] = [
      ['missed calls, hedged', { interpretation: 'Calls may be missed between 4 and 5pm.' }],
      ['unanswered inquiries, hedged', { interpretation: 'An inquiry might go unanswered late in the day.' }],
      ['voicemail', { interpretation: 'A caller after 4pm may reach voicemail.' }],
      ['lost leads in the title', { title: 'Possible lost leads from conflicting hours' }],
      ['dropped requests', { interpretation: 'Requests could be dropped when the office is closed.' }],
      ['conversion', { interpretation: 'This may affect conversion.' }],
      ['revenue', { interpretation: 'This could matter for revenue.' }],
      ['response time', { interpretation: 'Response time may suffer in the last hour.' }],
      ['slow follow-up', { interpretation: 'Late follow-up is possible on those days.' }],
      ['losing customers, hedged', { interpretation: 'The business might lose a customer who calls at 4:30.' }],
    ];
    it.each(OPERATIONAL_CLAIMS)('rejects an operational claim that cites only website evidence: %s', async (_label, over) => {
      const { vctx, claim } = await setup();
      const verdict = verifyProposal(claim(over), vctx());
      expect(verdict.ok).toBe(false);
      // loss and revenue wording is also caught by older, stricter rules; either rejection is correct
      if (!verdict.ok) expect(['operational_claim_without_operational_evidence', 'commercial_claim_without_owner_evidence', 'unsupported_loss_claim']).toContain(verdict.code);
    });

    it('the rule itself fires for missed calls, and names what is missing', async () => {
      const { vctx, claim } = await setup();
      expect(verifyProposal(claim({ interpretation: 'Calls may be missed between 4 and 5pm.' }), vctx())).toMatchObject({ ok: false, code: 'operational_claim_without_operational_evidence' });
    });

    it('conversion and revenue claims name their own rule when they cite only website evidence', async () => {
      const { vctx, claim } = await setup();
      for (const interpretation of ['This may affect conversion.', 'This could matter for revenue.', 'Sales may depend on which hours a caller sees.', 'The booking rate might differ between the two pages.']) {
        expect(verifyProposal(claim({ interpretation }), vctx()), interpretation).toMatchObject({ ok: false, code: 'commercial_claim_without_owner_evidence' });
      }
    });

    it('conversion and revenue need the owner’s own account; a customer comment is not enough', async () => {
      const { ctx, run, vctx, claim } = await setup();
      const comment = await addManualEvidence(ctx, { runId: run.id, kind: 'customer_comment', observation: 'A public forum comment says a call at 4:30pm was not answered.', observedAt: '2026-11-01', sourceUrl: 'https://forum.example.invalid/t/1', sourceAccess: 'public_page', sensitivity: 'public', identityMatch: 'confirmed', topic: 'callback', stance: 'reports_problem' });
      const withComment = (over: Partial<Proposal>) =>
        verifyProposal(claim({ title: 'One comment describes a call that was not answered', observed_fact: 'A comment observed on 2026-11-01 says a call was not answered.', evidence_ids: [comment.id], confidence: 'low', ...over }), vctx());
      // an account of what happened can support a hedged statement about a missed call
      expect(withComment({ interpretation: 'If the comment is accurate, a call may have been missed that afternoon.' })).toMatchObject({ ok: true });
      // but not a statement about money or conversion
      expect(withComment({ interpretation: 'If so, this may affect conversion.' })).toMatchObject({ ok: false, code: 'commercial_claim_without_owner_evidence' });
      expect(withComment({ interpretation: 'If so, this could matter for revenue.' })).toMatchObject({ ok: false, code: 'commercial_claim_without_owner_evidence' });
      // the owner's own account is the only thing that can carry such a statement
      const owner = await addManualEvidence(ctx, { runId: run.id, kind: 'owner_statement', observation: 'The owner said that web inquiries received after 4pm are called the next morning.', observedAt: '2026-11-10', sourceAccess: 'private_group', sensitivity: 'restricted', identityMatch: 'confirmed', topic: 'callback', stance: 'neutral' });
      const withOwner = verifyProposal(
        claim({ title: 'The owner describes next-morning follow-up', observed_fact: 'The owner said on 2026-11-10 that web inquiries received after 4pm are called the next morning.', evidence_ids: [owner.id], interpretation: 'If so, conversion of late-day inquiries may depend on that next-morning call.', confidence: 'low' }),
        vctx(),
      );
      expect(withOwner).toMatchObject({ ok: true });
    });

    it('questions, alternatives and conditional fixes may name the subject without making the claim', async () => {
      const { vctx, claim } = await setup();
      expect(
        verifyProposal(
          claim({
            owner_question: 'What happens to a call that comes in at 4:30pm?',
            alternative_explanations: ['Calls after closing may already go to an answering service.'],
            possible_fix: 'Only if the owner confirms a gap: missed-call capture after closing time.',
          }),
          vctx(),
        ),
      ).toMatchObject({ ok: true });
    });
  });
});
