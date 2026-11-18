// What a website SAYS about its hours and its emergency or after-hours
// service. Pure text analysis over the visible text of one page.
//
// These functions report statements. They do not decide which of two
// conflicting statements is right, and they say nothing about how a business
// actually answers its phone: a web page cannot show that.
//
// Honest limitation: this is pattern matching over English. It is written to
// under-claim: when wording is unclear the result is "ambiguous", never
// "the business offers this".

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof DAYS)[number];

export type HoursKind =
  /** ordinary published opening or office hours */
  | 'office'
  /** hours given for emergency, after-hours or on-call service, or "24 hours" */
  | 'emergency'
  /** hours labelled as seasonal or as belonging to one department (showroom, parts counter...) */
  | 'qualified';

export type HoursStatement = {
  /** the statement as written on the page */
  text: string;
  /** the statement with some surrounding text, for the reviewer */
  context: string;
  kind: HoursKind;
  /** for 'qualified': the label that qualified it, for example "showroom" or "summer" */
  qualifier: string | null;
  /** normalised form used ONLY to tell whether two statements say the same thing */
  key: string;
  /** per-day value, for example { mon: '09:00-17:00', sat: 'closed' }; days not mentioned are absent */
  days: Partial<Record<Day, string>>;
};

const DAY_RE = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\\.?';
const DAY_WORD_RE = "(?:weekdays|weekends|daily|every ?day|7 days(?: a week)?|seven days(?: a week)?)";
const DAY_SEP_RE = '\\s*(?:-|–|—|to|thru|through|&|and|,|\\/)\\s*';
const DAYSPEC_RE = `(?:${DAY_RE}(?:${DAY_SEP_RE}${DAY_RE})*|${DAY_WORD_RE})`;
const TIME_RE = '(?:\\d{1,2}(?::\\d{2})?\\s?(?:a\\.?m\\.?|p\\.?m\\.?)?|noon|midnight)';
const RANGE_RE = `${TIME_RE}\\s*(?:-|–|—|to|until|till?|thru|through)\\s*${TIME_RE}`;
const VALUE_RE = `(?:${RANGE_RE}|closed|by appointment(?: only)?|open 24 hours|24 hours)`;
const SEGMENT = new RegExp(`\\b(${DAYSPEC_RE})\\s*[:\\-–—,]?\\s*(${VALUE_RE})`, 'gi');

function dayIndex(token: string): number {
  return DAYS.indexOf(token.toLowerCase().slice(0, 3) as Day);
}

/** "Mon - Fri", "Mon, Wed & Fri", "weekdays" -> the days meant. Empty if it cannot be read. */
function expandDays(spec: string): Day[] {
  const s = spec.toLowerCase().trim();
  if (/^weekdays$/.test(s)) return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (/^weekends$/.test(s)) return ['sat', 'sun'];
  if (/^(?:daily|every ?day|7 days|seven days)/.test(s)) return [...DAYS];
  const out = new Set<Day>();
  const token = new RegExp(`(${DAY_RE})|(-|–|—|\\bto\\b|\\bthru\\b|\\bthrough\\b)`, 'gi');
  let previous = -1;
  let rangePending = false;
  for (const m of s.matchAll(token)) {
    if (m[2]) {
      rangePending = previous !== -1;
      continue;
    }
    const index = dayIndex(m[1]!);
    if (index === -1) return [];
    if (rangePending && previous !== -1) {
      for (let i = previous; ; i = (i + 1) % 7) {
        out.add(DAYS[i]!);
        if (i === index) break;
      }
    } else {
      out.add(DAYS[index]!);
    }
    previous = index;
    rangePending = false;
  }
  return DAYS.filter((d) => out.has(d));
}

type ParsedTime = { hour: number; minute: number; meridiem: 'am' | 'pm' | null };

function parseTime(raw: string): ParsedTime | null {
  const t = raw.toLowerCase().replace(/\./g, '').trim();
  if (t === 'noon') return { hour: 12, minute: 0, meridiem: 'pm' };
  if (t === 'midnight') return { hour: 12, minute: 0, meridiem: 'am' };
  const m = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return { hour, minute, meridiem: (m[3] as 'am' | 'pm' | undefined) ?? null };
}

const to24 = (t: ParsedTime, meridiem: 'am' | 'pm'): string => {
  const h = (t.hour % 12) + (meridiem === 'pm' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
};

/** "9am - 5pm", "8:30 to 4pm" -> "09:00-17:00". Null when neither time says am or pm, or it cannot be read. */
function normaliseRange(value: string): string | null {
  const parts = value.split(/\s*(?:-|–|—|\bto\b|\buntil\b|\btill?\b|\bthru\b|\bthrough\b)\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const open = parseTime(parts[0]!);
  const close = parseTime(parts[1]!);
  if (!open || !close) return null;
  // At least one side must say am or pm; otherwise "9 - 5" could be anything (a price, a date).
  if (!open.meridiem && !close.meridiem) return null;
  const closeMeridiem: 'am' | 'pm' = close.meridiem ?? (close.hour <= open.hour || close.hour === 12 ? 'pm' : 'am');
  const openMeridiem: 'am' | 'pm' = open.meridiem ?? (open.hour === 12 ? 'pm' : open.hour >= 7 ? 'am' : closeMeridiem);
  return `${to24(open, openMeridiem)}-${to24(close, closeMeridiem)}`;
}

function normaliseValue(value: string): string | null {
  const v = value.toLowerCase().trim();
  if (v === 'closed') return 'closed';
  if (v.startsWith('by appointment')) return 'by appointment';
  if (v.includes('24 hours')) return '24 hours';
  return normaliseRange(value);
}

const EMERGENCY_LABEL = /\b(?:emergenc(?:y|ies)|after[- ]hours|on[- ]call|24\s?\/\s?7)\b/i;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const SEASONAL_LABEL = new RegExp(`\\b(summer|winter|spring|fall|autumn|seasonal|holiday|off[- ]season|heating season|cooling season|${MONTH}\\s*(?:-|–|—|to|through|thru)\\s*${MONTH})\\b`, 'gi');
const EMERGENCY_PHRASE = /\b(?:emergenc(?:y|ies)|after[- ]hours|on[- ]call|24\s?\/\s?7)(?:\s+(?:service|repair|call|line))?(?:\s+hours)?\b/gi;
// "Store hours" and "shop hours" are a small contractor's ordinary hours, so they are not listed here.
const DEPARTMENT_LABEL = /\b(showroom|retail|parts counter|parts department|parts|sales office|sales department|sales|service department|service dept|warehouse|dispatch|installation department|install department)\b/gi;

const OFFICE_LABEL = /\b(?:(?:office|business|regular|normal|store|shop|our|opening) hours|hours of operation|hours)\b/i;

function lastIndexOfMatch(re: RegExp, text: string): number {
  let at = -1;
  for (const m of text.matchAll(new RegExp(re.source, 'gi'))) at = m.index!;
  return at;
}

function lastMatch(re: RegExp, text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1] ?? m[0];
  return last ? last.toLowerCase().replace(/\s+/g, ' ') : null;
}

const MAX_STATEMENTS = 8;

/**
 * Every distinct hours statement on a page, in page order. A statement is one
 * run of day/time segments ("Mon-Fri 8am-5pm, Sat 9am-12pm" is one statement).
 */
export function extractHoursStatements(pageText: string): HoursStatement[] {
  const flat = pageText.replace(/\s+/g, ' ');
  type Segment = { start: number; end: number; days: Day[]; value: string };
  const segments: Segment[] = [];
  for (const m of flat.matchAll(SEGMENT)) {
    const days = expandDays(m[1]!);
    const value = normaliseValue(m[2]!);
    if (days.length === 0 || value === null) continue;
    segments.push({ start: m.index!, end: m.index! + m[0].length, days, value });
  }
  // Segments separated by only a little text belong to one statement, unless that
  // text is itself a label ("Emergency:", "Showroom:"), which starts a new one.
  const groups: Segment[][] = [];
  for (const segment of segments) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    const gap = previous ? flat.slice(previous.end, segment.start) : '';
    const labelled = EMERGENCY_LABEL.test(gap) || new RegExp(SEASONAL_LABEL.source, 'i').test(gap) || new RegExp(DEPARTMENT_LABEL.source, 'i').test(gap) || OFFICE_LABEL.test(gap);
    if (current && previous && gap.length <= 30 && !labelled) current.push(segment);
    else groups.push([segment]);
  }

  const out: HoursStatement[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const start = group[0]!.start;
    const end = group[group.length - 1]!.end;
    // "Mon-Fri 8am-4pm." ends a sentence; "6 p.m." does not.
    const written = flat.slice(start, end).trim();
    const text = /[ap]\.m\.$/i.test(written) ? written : written.replace(/[.,;:\s]+$/, '');
    // The label is the text just before the statement, back to the previous sentence end.
    const before = flat.slice(Math.max(0, start - 70), start);
    const label = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? ')) + 1);
    const days: Partial<Record<Day, string>> = {};
    for (const segment of group) for (const d of segment.days) days[d] = days[d] && days[d] !== segment.value ? `${days[d]} and ${segment.value}` : segment.value;
    const key = DAYS.filter((d) => days[d] !== undefined).map((d) => `${d} ${days[d]}`).join('; ');

    let kind: HoursKind = 'office';
    let qualifier: string | null = null;
    // "24-Hour Emergency Service. Office hours: Mon-Fri 8-5" is office hours: the nearest label wins.
    const emergencyAt = lastIndexOfMatch(EMERGENCY_LABEL, label);
    // "Emergency hours:" and "after-hours" contain the word "hours"; blank them before looking for an office label.
    const officeAt = lastIndexOfMatch(OFFICE_LABEL, label.replace(EMERGENCY_PHRASE, (m) => ' '.repeat(m.length)));
    if (group.some((s) => s.value === '24 hours') || (emergencyAt !== -1 && emergencyAt > officeAt)) {
      kind = 'emergency';
    } else {
      const seasonal = lastMatch(SEASONAL_LABEL, `${label} ${text}`);
      const department = lastMatch(DEPARTMENT_LABEL, label);
      if (seasonal) {
        kind = 'qualified';
        qualifier = `seasonal (${seasonal})`;
      } else if (department) {
        kind = 'qualified';
        qualifier = department;
      }
    }
    const identity = `${kind}|${qualifier ?? ''}|${key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      text: text.slice(0, 200),
      context: `${start > 70 ? '…' : ''}${flat.slice(Math.max(0, start - 70), Math.min(flat.length, end + 40)).trim()}${end + 40 < flat.length ? '…' : ''}`.slice(0, 320),
      kind,
      qualifier,
      key,
      days,
    });
    if (out.length >= MAX_STATEMENTS) break;
  }
  return out;
}

/** True when two statements give different values for at least one day they both mention. */
export function hoursConflict(a: Pick<HoursStatement, 'days'>, b: Pick<HoursStatement, 'days'>): boolean {
  return DAYS.some((d) => a.days[d] !== undefined && b.days[d] !== undefined && a.days[d] !== b.days[d]);
}

// ---- emergency and after-hours wording ---------------------------------------

export type AvailabilityKind =
  /** says service is available outside office hours: "24/7", "24-hour emergency service", "after-hours service available" */
  | 'affirmative'
  /** says emergency service is offered, but not when */
  | 'emergency_offer'
  /** says it is NOT offered */
  | 'negative'
  /** mentions the subject without saying it is offered: advice, a question, a condition, mixed wording */
  | 'ambiguous';

export type AvailabilityStatement = { kind: AvailabilityKind; text: string; why: string };

const TERM = /\b(?:24\s?\/\s?7|24[- ]?hours?|24[- ]?hrs?|open 24|after[- ]hours|emergenc(?:y|ies)|nights? (?:and|&|or) weekends?|around the clock|round the clock|day or night)\b/i;
const COVERAGE = /\b(?:24\s?\/\s?7|24[- ]?hours?(?: a day)?|24[- ]?hrs?|open 24|after[- ]hours|around the clock|round the clock|day or night|nights? (?:and|&) weekends?)\b/gi;
const SERVICE_WORD = /\b(?:service|services|repair|repairs|emergenc(?:y|ies)|support|available|availability|call|calls|answer|answering|response|respond|dispatch|open|hours|on[- ]call|line|hotline|technicians?|help|(?:7|seven) days)\b/i;
// "within 24 hours", "24 hour notice", "a 24 hour schedule": a duration or a product feature, not availability.
const HOURS_COUNT = /^24[- ]?(?:hours?|hrs?)/i;
const DURATION_BEFORE = /\b(?:within|under|up to|at least|every|past|last|next|first|than)\s+(?:the\s+)?$/i;
const DURATION_AFTER = /^\s*(?:notice|schedule|timer|period|cycle|window|turnaround|delay|cancellation|hold|programming|battery|run ?time|warranty|guarantee|in advance|advance|before|prior|ago|or less|or sooner)\b/i;
const IN_BEFORE = /\bin\s+$/i;
const CLAUSE_END_AFTER = /^\s*(?:[.,;!?]|$)/;
const EMERGENCY_SERVICE = /\bemergenc(?:y|ies)\s+(?:\w+\s+){0,3}(?:service|services|repair|repairs|calls?|line|response|support|appointments?|visits?|dispatch)\b|\b(?:service|services|repair|repairs|response|support)\s+(?:\w+\s+){0,3}emergenc(?:y|ies)\b/i;
const OFFER = /\b(?:we(?:'re| are)? (?:also )?(?:offer|offering|provide|providing|have|available|here|ready|on call)|we (?:answer|respond|handle|take)|(?:is|are) available|available (?:for|to)|call (?:us )?(?:any ?time|now|today)|on[- ]call|ready (?:for|to (?:help|assist|respond))|here for you|at your (?:service|disposal)|offering|offers|provides)\b/i;

const NEG_OFFER = /\b(?:do not|don't|does not|doesn't|cannot|can't|can ?not|unable to|no longer|not able to|won't|will not|never)\s+(?:currently\s+|yet\s+)?(?:offer|provide|have|do|accept|take|handle|respond|answer|make|work)\b/i;
// "No emergency service", "no after-hours calls". The service noun is required:
// "No emergency is too small" is a slogan, not a statement that nothing is offered.
const NEG_DIRECT = /\bno (?:24[- ]?hours?|24\s?\/\s?7|after[- ]hours|emergenc(?:y|ies)|weekend|night|evening)\s+(?:\w+\s+){0,2}(?:service|services|repair|repairs|calls?|hours|appointments?|work|visits?|availability|coverage|support|response|dispatch|line)\b/i;
const NEG_AFTER = /\b(?:24\s?\/\s?7|24[- ]?hours?|after[- ]hours|emergenc(?:y|ies)|weekends?|nights?)\b[^.!?\n]{0,60}\b(?:(?:is|are|was|were)\s+(?:not|no longer)\b|isn't|aren't|not (?:available|offered|provided|an option)|unavailable|not offered)/i;
const NEG_CLOSED = /\bclosed (?:on |for |at )?(?:nights|evenings|weekends|after hours)\b|\bnot (?:a|an) (?:24[- ]?hours?|24\s?\/\s?7|emergency)\b/i;
const CONTRAST = /\b(?:but|however|except|although|though|unless)\b/i;

const INFORMATIONAL = /\?\s*$|\b(?:call|dial) 911\b|\bemergency (?:heat|shut[- ]?off|switch|stop|exit|kit|fund|contact|number|room|setting)\b|\bin (?:case of |an |the event of an? )emergenc|\bwhat to do\b|\bsigns? (?:of|that)\b|\bhow to\b|\btips?\b|\b(?:avoid|prevent|preventing|avoiding)\b[^.!?\n]{0,30}\bemergenc|\bbefore (?:it|they) becomes? an emergenc|\bleave (?:a|us a) message\b/i;
const LIMITED = /\bduring (?:business|office|regular|normal|working|our) hours\b|\bmembers? only\b|\b(?:plan|agreement|contract) (?:members|customers|holders)\b|\bexisting customers\b|\bby appointment\b|\bwhen available\b|\bsubject to availability\b/i;

function sentencesOf(pageText: string): string[] {
  return pageText
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0 && s.length <= 400);
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Classifies ONE sentence. Returns null when it does not touch the subject at all. */
export function classifyAvailabilitySentence(sentence: string): AvailabilityStatement | null {
  if (!TERM.test(sentence)) return null;
  const text = sentence.slice(0, 300);
  const negative = NEG_OFFER.test(sentence) || NEG_DIRECT.test(sentence) || NEG_AFTER.test(sentence) || NEG_CLOSED.test(sentence);
  const short = wordCount(sentence) <= 8;
  // A coverage term counts only next to a word about service; "24 hours" alone can describe anything.
  let coverage = false;
  for (const m of sentence.matchAll(COVERAGE)) {
    const before = sentence.slice(Math.max(0, m.index! - 80), m.index!);
    const after = sentence.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
    if (HOURS_COUNT.test(m[0]) && (DURATION_BEFORE.test(before) || DURATION_AFTER.test(after) || (IN_BEFORE.test(before) && CLAUSE_END_AFTER.test(after)))) continue;
    if (SERVICE_WORD.test(`${before} ${after}`)) coverage = true;
  }
  const emergencyService = EMERGENCY_SERVICE.test(sentence);
  const offer = OFFER.test(sentence);

  if (negative) {
    // "We do not offer 24/7 service, but emergency calls are returned next morning": too mixed to call.
    if (CONTRAST.test(sentence) && (coverage || (emergencyService && offer))) return { kind: 'ambiguous', text, why: 'says both that something is and is not offered' };
    return { kind: 'negative', text, why: 'says it is not offered' };
  }
  if (INFORMATIONAL.test(sentence)) return { kind: 'ambiguous', text, why: 'advice, a question or general information, not an offer' };
  if (LIMITED.test(sentence) && (coverage || emergencyService)) return { kind: 'ambiguous', text, why: 'offered only under a stated condition' };
  if (coverage) return { kind: 'affirmative', text, why: 'states availability around the clock or outside office hours' };
  if (emergencyService && (offer || short)) return { kind: 'emergency_offer', text, why: 'says emergency service is offered, without saying when' };
  return { kind: 'ambiguous', text, why: 'mentions the subject without saying it is offered' };
}

const MAX_AVAILABILITY = 8;

/** Every sentence on the page about emergency or after-hours service, classified. */
export function extractAvailabilityStatements(pageText: string): AvailabilityStatement[] {
  const out: AvailabilityStatement[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(pageText)) {
    const found = classifyAvailabilitySentence(sentence);
    if (!found) continue;
    const id = `${found.kind}|${found.text.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(found);
    if (out.length >= MAX_AVAILABILITY) break;
  }
  return out;
}
