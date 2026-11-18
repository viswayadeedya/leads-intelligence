// Claim-to-evidence validator (docs/quality/EVIDENCE_POLICY.md).
//
// Honest limitation: the text rules below are heuristics over English wording.
// They catch known failure shapes (invented numbers, loss claims, certainty,
// overgeneralization, unscoped absence, unsupported attribution) and a set of
// paraphrases of each. They cannot prove that a sentence is semantically
// supported, and tests/semantic-claims.test.ts lists wordings that still get
// through. Human evidence review and explicit human approval remain the gate
// before anything reaches an owner; nothing here replaces them.
//
// The rules fail closed: a careful claim that trips a rule is rejected and
// logged, which costs a finding but never publishes an overclaim.

import type { Business, Caveat, Confidence, Evidence, EvidenceType, SourceRecord } from '../types';
import { ProposalSchema, type Proposal } from './reasoner';

export type VerifierContext = {
  business: Pick<Business, 'id' | 'city'> & Partial<Pick<Business, 'domain'>>;
  runId: string;
  /** Evidence this reasoning pass is allowed to cite. Anything else is treated as nonexistent. */
  evidenceById: Map<string, Evidence>;
  sourceRecordsById: Map<string, SourceRecord>;
  runSourceRecords: SourceRecord[];
  now: Date;
  staleAfterDays: number;
};

export type Rejection = { code: string; message: string; proposalTitle: string };
export type VerifiedProposal = { proposal: Proposal; caveats: Caveat[] };
export type VerifyOutcome = { accepted: VerifiedProposal[]; rejections: Rejection[]; outputInvalid: boolean };

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

// ---- text preparation -------------------------------------------------------

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁦-⁯︀-️﻿]/;
const LATIN = /\p{Script=Latin}/u;
const OTHER_ALPHABET = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

/** A word that mixes Latin letters with look-alike letters from another alphabet. */
function hasMixedScriptWord(text: string): boolean {
  for (const word of text.split(/[^\p{L}\p{M}]+/u)) {
    if (word && LATIN.test(word) && OTHER_ALPHABET.test(word)) return true;
  }
  return false;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

/**
 * Compatibility-normalizes (full-width digits, ligatures), undoes digit-for-
 * letter swaps inside words, and collapses spaced-out letters, so "l0sing",
 * "ｌosing" and "l o s i n g" are all read as "losing".
 */
export function normalizeClaimText(text: string): string {
  let out = text.normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―−]/g, '-');
  out = out.replace(/(?<=\p{L})[013457](?=\p{L})/gu, (c) => LEET[c] ?? c);
  out = out.replace(/\b(?:\p{L} ){3,}\p{L}\b/gu, (m) => m.replace(/ /g, ''));
  return out;
}

const WORD_NUMBER: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
  twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
};
const WORD_NUMBER_RE = new RegExp(`\\b(?:${Object.keys(WORD_NUMBER).join('|')})\\b`, 'gi');

function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

/** Digits plus spelled-out numbers ("three pages"). "one" is skipped: it is too often a pronoun. */
function quantitiesIn(text: string): string[] {
  const words = (text.match(WORD_NUMBER_RE) ?? []).map((w) => w.toLowerCase()).filter((w) => w !== 'one').map((w) => WORD_NUMBER[w]!);
  return [...numbersIn(text), ...words];
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+/).map((s) => s.trim()).filter(Boolean);
}

// ---- rules ------------------------------------------------------------------

const PEOPLE = '(?:customers?|callers?|calls?|leads?|visitors?|people|homeowners?|requests?|inquir(?:y|ies)|enquir(?:y|ies)|jobs?|bookings?|prospects?|clients?)';

/** People only. "A comment describes a call that was missed" is a reported event, not a loss claim. */
const PERSONS = '(?:customers?|callers?|leads?|visitors?|people|homeowners?|prospects?|clients?|buyers?|shoppers?)';

const QUANTIFIED_IMPACT = new RegExp(
  [
    '[$€£¥₹]\\s?\\d',
    '\\b\\d[\\d,.]*\\s?(?:dollars?|usd|eur|gbp|bucks|grand|percent|per cent|pct)\\b',
    '\\b(?:usd|eur|gbp)\\s?\\d',
    '\\d\\s?%',
    '\\b\\d+(?:\\.\\d+)?\\s?[km]\\b',
    '\\b\\d+(?:\\.\\d+)?\\s?x\\b',
    '\\bper (?:month|week|year|day|call|job)\\b',
    '\\/\\s?(?:mo|month|wk|week|yr|year)\\b',
    '\\b(?:monthly|weekly|annual(?:ly)?|yearly|a (?:month|week|year))\\b',
    '\\b(?:thousands|hundreds|millions|tens of|dozens)\\b',
    '\\b(?:four|five|six|seven)[- ]figures?\\b',
    '\\b(?:twice|double[sd]?|doubling|triple[sd]?|tripling|tenfold|\\w+fold)\\b',
    '\\b(?:percent|percentage|dollars?|revenue figure)\\b',
    `\\b(?:half|a third|one third|two thirds|a quarter|the majority|a majority|most|a (?:large|big|significant|meaningful|sizable|sizeable|good) (?:share|portion|part|number|chunk)|share|portion|proportion|fraction) of (?:all |the |its |their |your )?(?:\\w+ )?${PEOPLE}`,
    `\\b(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:out of|in) (?:every )?(?:\\d+|two|three|four|five|six|seven|eight|nine|ten)\\b`,
  ].join('|'),
  'i',
);

const LOSS_CLAIM = new RegExp(
  [
    `\\b(?:losing|loses?|lost|costing|missing out on|miss(?:es|ing)? out on|forfeit\\w*|sacrific\\w+|squander\\w*|wast(?:es|ing)|bleed(?:s|ing)?|hemorrhag\\w+|haemorrhag\\w+|leak(?:s|ing)?|shed(?:s|ding)?|giv(?:es|ing) up|throw(?:s|ing) away|turn(?:s|ing) away|driv(?:es|ing) (?:away|off)|scar(?:es|ing) (?:away|off)|push(?:es|ing) away)\\b[^.]{0,40}\\b(?:${PEOPLE}|revenue|money|business|sales|income|profit|work|opportunit(?:y|ies))`,
    `\\b${PERSONS}\\b[^.]{0,30}\\b(?:are|is|get|gets|being|keep|keeps)?\\s?(?:lost|going elsewhere|goes? elsewhere|going to (?:a |the )?competitors?|walk(?:s|ing)? away|slip(?:s|ping)? (?:away|through)|fall(?:s|ing)? through the cracks|turned away|driven away|left on the table)`,
    '\\b(?:money|revenue|business|sales|jobs|work|leads) (?:is |are )?(?:left |being left )?on the table\\b',
    '\\b(?:lost|missed|leaked|foregone|forgone) (?:revenue|sales|income|business|jobs|leads|customers|opportunit(?:y|ies))\\b',
    '\\b(?:revenue|sales|profit|lead|customer) (?:leak|leakage|drain|loss|losses|attrition|churn)\\b',
    '\\bcosts? (?:you|them|the business|the company|the owner)\\b',
    '\\b(?:hurting|hurts|harming|harms|damaging|damages|killing|kills|undermin\\w+|eroding|erodes) (?:the |your |their |its )?(?:sales|revenue|business|reputation|growth|bottom line|conversions?)\\b',
    '\\bguarantee',
  ].join('|'),
  'i',
);

const SYSTEMIC = /\b(?:always|never|systemic|consistently|routinely|frequently|widespread|typically|most customers|many customers|several (?:reviews|customers|comments)|customers (?:are|say|report|complain|always|often)|a pattern of)\b/i;
// Paraphrases, checked on the assertive fields only (a question may ask "how do you usually...").
const SYSTEMIC_PARAPHRASE = new RegExp(
  [
    '\\b(?:all the time|every time|each time|time and again|time after time|again and again|over and over|repeatedly|regularly|habitually|chronic(?:ally)?|notorious(?:ly)?|perennial(?:ly)?|recurring|recurrent|persistent(?:ly)?|ongoing (?:problem|issue|complaint)s?|common(?:ly)? (?:complaint|problem|issue)s?|across the board|in general|generally|usually|as a rule|more often than not|tends? to|known for|has a (?:habit|history|reputation|track record)|keeps? (?:saying|complaining|reporting|happening)|everyone|everybody|nobody|no one|numerous|countless|plenty of|lots of|a lot of|scores of)\\b',
    '(?<!how )\\boften\\b',
    `\\b(?:multiple|various|several|many|most|all|some) (?:of (?:the |its |their )?)?(?:${PEOPLE}|reviews?|reviewers?|comments?|complaints?|accounts?|reports?)\\b`,
    '\\b(?:people|reviewers|customers|callers|homeowners|residents|locals) (?:are|say|said|report|complain|mention|describe|keep|have)\\b',
  ].join('|'),
  'i',
);

const CERTAINTY = new RegExp(
  [
    '\\b(?:proves?|proven|proof|clearly|obviously|evidently|definitely|undoubtedly|certainly|unquestionably|undeniabl[ey]|without (?:a )?doubt|no doubt|it is certain|for sure|inevitabl[ey]|invariably|demonstrates|confirms|establishes|makes (?:it )?clear)\\b',
    '\\b(?:is|are|was|were) (?:causing|responsible for|to blame for|the reason|the cause|why)\\b',
    '\\b(?:the reason|the cause|the root cause|the source of the problem)\\b',
    '\\b(?:because of this|as a result|therefore|thus|hence|consequently|which means|this means|that means|meaning that|so customers|so callers|so they)\\b',
    `\\b(?:will|must|is bound to|are bound to|is sure to|are sure to) (?:\\w+ ){0,2}(?:lose|miss|leave|go|give up|hang up|call|choose|pick|turn|walk|abandon|bounce)\\b`,
  ].join('|'),
  'i',
);

const HEDGE = /\b(?:may|might|could|possibl[ey]|perhaps|maybe|potential(?:ly)?|if|whether|unclear|not clear|unknown|cannot|can't|not known|depends?|worth (?:checking|asking)|appears?|seems?|suggests?|would need)\b/i;
const CONDITIONAL_FIX = /\b(?:if|only if|once|after|should|provided|assuming|depending|depends|when the owner|confirms?|confirmed)\b/i;

const OUTCOME_PROMISE = new RegExp(
  [
    '\\b(?:will|would|is going to|are going to|guarantee[sd]?|ensures?|ensured|certain to|sure to)\\s+(?:\\w+\\s+){0,3}(?:increase|boost|grow|double|triple|improve|recover|capture|win|save|fix|solve|eliminate|stop|prevent|convert|generate|bring|deliver|pay for itself)\\b',
    '\\b(?:never miss|no more missed|stop missing|stop losing|more (?:bookings|jobs|customers|leads|revenue|sales|calls)|increased? (?:bookings|revenue|sales|conversions?)|higher (?:conversion|revenue|sales)|pays? for itself|return on investment|roi)\\b',
  ].join('|'),
  'i',
);

const COMPARISON = /\b(?:competitors?|competition|rivals?|other (?:hvac |local |nearby )?(?:companies|businesses|contractors|shops|providers)|industry (?:average|standard|norm|benchmark|practice)|best practices?|unlike (?:most|other|many)|compared (?:to|with)|(?:better|worse|slower|faster|weaker|stronger) than|lags?|lagging|falls? (?:behind|short)|behind the|ahead of|most (?:businesses|companies|contractors|shops)|peers?)\b/i;

const ACCUSATORY = /\byour (?:team|staff|office|business|company|people)\b[^.]{0,30}\b(?:never|doesn't|does not|don't|do not|fails?|ignores?|refuses?|won't|can't be bothered)\b|\byou(?:'re| are) (?:losing|missing|ignoring|failing|neglecting)\b|\b(?:negligen\w+|incompeten\w+|unprofessional|lazy|careless(?:ly)?|sloppy|shoddy|terrible|awful|bad service)\b/i;

const CURRENT_WORDING = /\b(?:currently|right now|at present|presently|today|as of now|is still|are still|still|these days|nowadays|at the moment|at this time|to this day|ongoing|continues? to|remains?|as it stands|this (?:week|month|year))\b/i;

const ABSENCE = new RegExp(
  [
    "\\b(?:no|not found|none|lacks?|lacking|missing|without|absent|unavailable|zero|nonexistent|non-existent|nowhere|nothing|neither|does not (?:have|offer|list|provide|exist|appear|include)|doesn't (?:have|offer|list|provide|exist|appear|include)|do not (?:have|offer|list|provide|exist)|don't (?:have|offer|list|provide)|has no|have no|there (?:is|are) no|there (?:isn't|aren't|is not|are not)|isn't (?:available|offered|possible|provided|listed)|is not (?:available|offered|possible|provided|listed)|not (?:available|offered|possible|provided|listed|present|there)|no way to|unable to|impossible to|can(?:'|no)?t (?:book|schedule|request|find|contact|reach|submit)|cannot (?:book|schedule|request|find|contact|reach|submit)|fails? to (?:offer|provide|list|have|include)|only (?:by|via|through|over) (?:the )?phone|phone[- ]only|only option is|sole (?:option|way|channel))\\b",
  ].join('|'),
  'i',
);
const ABSENCE_SCOPE = /\b(?:pages?|site|website|html)\b[^.;]{0,60}\b(?:inspected|checked|sampled|reviewed)\b|\b(?:inspected|checked|sampled|reviewed)\b[^.;]{0,60}\b(?:pages?|site|website|html)\b/i;

const LOCALITY = /\b(?:local(?:ly)?|nearby|in (?:the|this) area|around here|in town|neighbou?rhood)\b/i;

/** Wording that says how the business behaves, as opposed to what a page shows. */
const BEHAVIOR = /\b(?:answers?|answered|answering|unanswered|responds?|responded|responding|unresponsive|repl(?:y|ies|ied)|returns? (?:calls?|messages?|voicemails?)|returned|unreturned|not returned|calls? (?:people |customers |them )?back|called back|callbacks?|picks? up|picked up|ignores?|ignored|follows? up|followed up|follow-up|shows? up|showed up|no-shows?|arrives?|arrived|late|waits?|waited|waiting|on hold|goes to voicemail|went to voicemail|hangs? up)\b/i;
const BEHAVIOR_EVIDENCE: EvidenceType[] = ['customer_comment', 'owner_statement', 'operator_observation'];
/** The fact must be reported as someone's account, not asserted. */
const ATTRIBUTION = /\b(?:comments?|accounts?|posts?|reviews?|reviewers?|commenters?|describes?|described|says?|said|wrote|written|reports?|reported|according to|states?|stated|mentions?|mentioned|recorded|noted|observed by|the operator|the owner (?:says|said|stated|wrote))\b/i;

const SOURCE_WORDS = /\b(?:reviews?|reviewers?|ratings?|stars?|testimonials?|google|yelp|facebook|reddit|nextdoor|angi|angie's list|homeadvisor|thumbtack|bbb|better business bureau|trustpilot|forum|survey|polls?|stud(?:y|ies)|research|data shows?|statistics?|analytics|call logs?|crm|records show)\b/gi;

const URLISH = /https?:\/\/[^\s)"'<>]+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s)"'<>]*|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|app|biz|info|us|ly|me|dev|shop|store|online|site|xyz)\b/gi;
const PERSONAL_DETAIL = /[\w.+-]+@[\w-]+\.[\w.-]+|(?:^|\s)@\w{2,}|\bu\/\w{2,}/;
const MARKUP = /<\s*\/?\s*[a-z!]|\]\s*\(|!\[|javascript:|data:text|&#|\\u00|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i;
const VAGUE_QUANTITY = /\b(?:several|many|numerous|multiple|various|dozens|a (?:number|handful|couple|few|bunch|lot) of|a few|countless|plenty|scores|most|some of)\b/i;

/** Features an observed fact can say are missing, and the evidence type that records each. */
const FEATURES: { type: EvidenceType; re: RegExp }[] = [
  { type: 'booking_link', re: /\b(?:book(?:ing)?|appointments?|schedul\w+|reserv\w+)\b/i },
  { type: 'contact_form', re: /\b(?:contact form|web form|request form|online form|form)\b/i },
  { type: 'after_hours_statement', re: /\b(?:after[- ]hours|out[- ]of[- ]hours|emergency|24\/7|24-hour|round[- ]the[- ]clock|weekends?|evenings?|nights?)\b/i },
  { type: 'phone_listed', re: /\b(?:phone number|telephone number|phone)\b/i },
];

function title(value: unknown): string {
  if (typeof value === 'object' && value !== null && typeof (value as { title?: unknown }).title === 'string') {
    return ((value as { title: string }).title || '(untitled)').slice(0, 120);
  }
  return '(untitled)';
}

export function verifyProposal(raw: Proposal, ctx: VerifierContext): { ok: true; caveats: Caveat[] } | { ok: false; code: string; message: string } {
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  const ids = [...new Set(raw.evidence_ids)];
  if (ids.length === 0) return fail('no_evidence', 'A factual claim must cite at least one evidence ID.');

  const cited: Evidence[] = [];
  for (const id of ids) {
    const ev = ctx.evidenceById.get(id);
    // Only IDs from the current run are admissible.
    if (!ev || ev.runId !== ctx.runId) return fail('unknown_evidence_id', `Evidence ID ${id.slice(0, 40)} does not exist in this investigation.`);
    if (ev.businessId !== ctx.business.id) return fail('wrong_business', 'Cited evidence belongs to a different business.');
    if (ev.identityMatchStatus !== 'confirmed') return fail('identity_not_confirmed', 'Cited evidence is not confirmed to be about this business.');
    if (ev.supersededBy) return fail('evidence_superseded', 'Cited evidence was replaced by a newer observation.');
    if (ev.verificationStatus === 'rejected') return fail('evidence_rejected', 'Cited evidence was rejected by the reviewer.');
    if (ev.evidenceType === 'instruction_like_text') return fail('inadmissible_evidence', 'Instruction-like page text cannot support a claim.');
    cited.push(ev);
  }

  // ---- obfuscation: refuse rather than guess --------------------------------
  const rawFields = [raw.title, raw.observed_fact, raw.interpretation, raw.possible_fix, raw.owner_question, ...raw.alternative_explanations];
  // Fields are joined with a full stop so that no rule can match across two fields.
  const FIELD_BREAK = ' .\n ';
  const rawAll = rawFields.join(FIELD_BREAK);
  if (INVISIBLE.test(rawAll) || hasMixedScriptWord(rawAll)) {
    return fail('obfuscated_text', 'The claim contains invisible characters or look-alike letters from another alphabet.');
  }
  if (MARKUP.test(rawAll)) return fail('markup_in_claim', 'The claim contains markup, a link construct or control characters.');

  const p = {
    title: normalizeClaimText(raw.title),
    observed_fact: normalizeClaimText(raw.observed_fact),
    interpretation: normalizeClaimText(raw.interpretation),
    possible_fix: normalizeClaimText(raw.possible_fix),
    owner_question: normalizeClaimText(raw.owner_question),
    alternative_explanations: raw.alternative_explanations.map(normalizeClaimText),
  };
  const all = [p.title, p.observed_fact, p.interpretation, p.possible_fix, p.owner_question, ...p.alternative_explanations].join(FIELD_BREAK);
  /** Fields that assert something, as opposed to asking or offering alternatives. */
  const assertive = [p.title, p.observed_fact, p.interpretation].join(FIELD_BREAK);

  if (QUANTIFIED_IMPACT.test(all)) {
    return fail('unsupported_quantified_impact', 'Dollar, percentage, share or multiple figures need an owner-provided baseline, which this investigation does not have.');
  }
  if (LOSS_CLAIM.test(all)) {
    return fail('unsupported_loss_claim', 'The claim asserts lost customers, revenue or a guarantee that the evidence cannot show.');
  }
  // Checked on the text as written: normalization would rewrite the "@".
  if (PERSONAL_DETAIL.test(rawAll)) return fail('personal_detail', 'The claim contains an email address or username.');

  // Every quantity in the observed fact must come from the cited evidence.
  const corpus = cited
    .map((e) => [e.observation, e.supportingExcerpt ?? '', e.observedAt.slice(0, 10), JSON.stringify(e.locator)].join(' '))
    .join(' ');
  const allowed = new Set(quantitiesIn(corpus));
  for (let n = 0; n <= cited.length; n++) allowed.add(String(n));
  for (const n of quantitiesIn(p.observed_fact)) {
    if (!allowed.has(n)) return fail('invented_statistic', `The number "${n}" in the observed fact does not appear in the cited evidence.`);
  }
  if (VAGUE_QUANTITY.test(p.observed_fact)) {
    return fail('vague_quantity', 'An observed fact must state exactly what was seen, not "several" or "many".');
  }

  // Links, domains and named sources must come from the cited evidence.
  const sourceCorpus = `${corpus} ${cited.flatMap((e) => e.sourceRecordIds.map((id) => ctx.sourceRecordsById.get(id)?.sourceUrl ?? '')).join(' ')} ${ctx.business.domain ?? ''}`.toLowerCase();
  for (const url of all.match(URLISH) ?? []) {
    if (!sourceCorpus.includes(url.toLowerCase().replace(/[.,;:]+$/, ''))) {
      return fail('unsupported_url', 'The claim contains a link or domain that is not in the cited evidence.');
    }
  }
  for (const word of assertive.match(SOURCE_WORDS) ?? []) {
    if (!sourceCorpus.includes(word.toLowerCase())) {
      return fail('unsupported_attribution', `The claim refers to a source ("${word}") that the cited evidence does not mention.`);
    }
  }

  const caveats = new Set<Caveat>();
  for (const e of cited) for (const c of e.caveats) caveats.add(c);

  const minConfidence = cited.reduce<Confidence>((min, e) => (RANK[e.confidence] < RANK[min] ? e.confidence : min), 'high');
  if (RANK[raw.confidence] > RANK[minConfidence]) {
    return fail('confidence_too_high', `Confidence "${raw.confidence}" exceeds the weakest cited evidence ("${minConfidence}").`);
  }

  const anecdotal = cited.some((e) => e.caveats.includes('anecdotal'));
  if ((SYSTEMIC.test(all) || SYSTEMIC_PARAPHRASE.test(assertive)) && (anecdotal || cited.length < 5)) {
    return fail('overgeneralization', 'The wording implies a pattern that a small number of observations cannot support.');
  }

  if (CERTAINTY.test(assertive)) {
    return fail('overstated_certainty', 'The wording states a cause or a certainty. Evidence here supports an observation and a hypothesis, not a proven effect.');
  }
  if (COMPARISON.test(assertive) || COMPARISON.test(p.possible_fix)) {
    return fail('unsupported_comparison', 'The claim compares the business with others, and this investigation holds no evidence about anyone else.');
  }
  if (ACCUSATORY.test(all)) {
    return fail('accusatory_wording', 'The wording accuses or disparages the business instead of describing what was observed.');
  }
  if (OUTCOME_PROMISE.test(all)) {
    return fail('unsupported_outcome_promise', 'The claim promises a result. Only what the evidence shows, and a conditional suggestion, may be stated.');
  }
  if (!HEDGE.test(p.interpretation)) {
    return fail('interpretation_not_hedged', 'The interpretation must be worded as a possibility ("may", "if", "whether"), because it is a hypothesis.');
  }
  if (!CONDITIONAL_FIX.test(p.possible_fix)) {
    return fail('fix_not_conditional', 'A possible fix must be conditional on the owner confirming the gap.');
  }

  const staleCutoff = ctx.now.getTime() - ctx.staleAfterDays * 86_400_000;
  const staleEvidence = cited.filter((e) => new Date(e.observedAt).getTime() < staleCutoff);
  if (staleEvidence.length > 0) {
    caveats.add('stale');
    if (CURRENT_WORDING.test(all)) {
      return fail('stale_presented_as_current', 'Older evidence is worded as if it describes the present.');
    }
    if (!staleEvidence.every((e) => p.observed_fact.includes(e.observedAt.slice(0, 4)))) {
      return fail('stale_without_date', 'A claim built on older evidence must state when that evidence was observed.');
    }
  }

  // ---- behaviour: only from an account of behaviour, and only as an account ---
  if (BEHAVIOR.test(p.observed_fact) || BEHAVIOR.test(p.title)) {
    const behaviorEvidence = cited.filter((e) => BEHAVIOR_EVIDENCE.includes(e.evidenceType));
    if (behaviorEvidence.length === 0) {
      return fail('behavior_claim_without_evidence', 'The claim says how the business answers or follows up, but cites only what a web page shows.');
    }
    if (!ATTRIBUTION.test(p.observed_fact)) {
      return fail('anecdote_stated_as_fact', 'An account by one person must be reported as an account ("a comment says"), not stated as fact.');
    }
    // A reported problem cannot be cited while a contrary account on the same topic is left out.
    for (const e of behaviorEvidence) {
      if (e.stance !== 'reports_problem' || !e.topic) continue;
      const contrary = [...ctx.evidenceById.values()].some(
        (o) => o.topic === e.topic && o.stance === 'reports_positive' && !o.supersededBy && o.verificationStatus !== 'rejected' && o.identityMatchStatus === 'confirmed' && !ids.includes(o.id),
      );
      if (contrary) return fail('omits_contradicting_evidence', 'Another observation on the same topic says the opposite and is not cited.');
    }
  }

  // ---- absence: sentence by sentence -----------------------------------------
  const absenceSentences = [...sentences(p.observed_fact), p.title].filter((s) => ABSENCE.test(s));
  if (absenceSentences.length > 0) {
    const absenceEvidence = cited.filter((e) => e.polarity === 'absence');
    const anecdotalOnly = cited.every((e) => BEHAVIOR_EVIDENCE.includes(e.evidenceType));
    // "was not returned" in a reported account is not a claim about the website.
    if (!anecdotalOnly) {
      if (absenceEvidence.length === 0) {
        return fail('absence_not_supported', 'The observed fact says something is missing, but no cited evidence records an absence.');
      }
      if (!sentences(p.observed_fact).filter((s) => ABSENCE.test(s)).every((s) => ABSENCE_SCOPE.test(s))) {
        return fail('absence_without_scope', 'An absence claim must state its scope in the same sentence (for example "on the pages inspected").');
      }
      if (ABSENCE.test(p.title) && !/\b(?:inspected|checked|sampled|reviewed)\b/i.test(p.title)) {
        return fail('absence_without_scope', 'A title that says something is missing must state its scope (for example "on inspected pages").');
      }
      const websiteFailures = ctx.runSourceRecords.filter((r) => r.sourceType === 'website' && r.accessStatus !== 'ok');
      const citedSourcesOk = absenceEvidence.every((e) => e.sourceRecordIds.every((id) => ctx.sourceRecordsById.get(id)?.accessStatus === 'ok'));
      if (websiteFailures.length > 0 || !citedSourcesOk) {
        return fail('absence_from_incomplete_collection', 'Some sources were blocked or failed, so "not found" cannot be concluded.');
      }
      // Each thing said to be missing needs its own absence observation, and must not have been found.
      const absentTypes = new Set(absenceEvidence.map((e) => e.evidenceType));
      for (const sentence of absenceSentences) {
        // Only the part of the sentence from the absence word onwards names what is missing.
        const from = sentence.slice(Math.max(0, sentence.search(ABSENCE)));
        for (const feature of FEATURES) {
          if (!feature.re.test(from)) continue;
          const found = [...ctx.evidenceById.values()].some(
            (e) => e.evidenceType === feature.type && e.polarity === 'presence' && !e.supersededBy && e.verificationStatus !== 'rejected' && e.identityMatchStatus === 'confirmed',
          );
          if (found) return fail('contradicts_run_evidence', `The claim says a ${feature.type.replace(/_/g, ' ')} is missing, but this investigation observed one.`);
          if (feature.type !== 'phone_listed' && !absentTypes.has(feature.type)) {
            return fail('absence_feature_not_cited', `The claim says a ${feature.type.replace(/_/g, ' ')} is missing without citing an observation that records it.`);
          }
        }
      }
    }
  }

  const allGeoUncertain = cited.every((e) => e.caveats.includes('geo_uncertain'));
  if (allGeoUncertain) {
    const city = ctx.business.city.trim().toLowerCase();
    if (LOCALITY.test(all) || (city && all.toLowerCase().includes(city))) {
      return fail('geo_unsupported', 'The cited search observations have no recorded location, so a location-specific claim is not supported.');
    }
  }

  return { ok: true, caveats: [...caveats] };
}

/** Validates raw reasoner output. Bad proposals are rejected individually and reported. */
export function verifyReasonerOutput(raw: unknown, ctx: VerifierContext): VerifyOutcome {
  const rejections: Rejection[] = [];
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { opportunities?: unknown }).opportunities)) {
    return {
      accepted: [],
      rejections: [{ code: 'model_invalid_output', message: 'Reasoner output was not the expected JSON shape. No claims were accepted.', proposalTitle: '(whole output)' }],
      outputInvalid: true,
    };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'opportunities') {
      rejections.push({
        code: 'unexpected_output_field',
        message: `Reasoner output contained an unsupported field "${key.slice(0, 40)}". It was discarded; reasoner output cannot trigger actions.`,
        proposalTitle: '(whole output)',
      });
    }
  }
  const accepted: VerifiedProposal[] = [];
  const proposals = ((raw as { opportunities: unknown[] }).opportunities).slice(0, 25);
  for (const candidate of proposals) {
    const parsed = ProposalSchema.safeParse(candidate);
    if (!parsed.success) {
      rejections.push({ code: 'schema_invalid', message: 'Proposal did not match the required structure.', proposalTitle: title(candidate) });
      continue;
    }
    const verdict = verifyProposal(parsed.data, ctx);
    if (!verdict.ok) {
      rejections.push({ code: verdict.code, message: verdict.message, proposalTitle: parsed.data.title });
      continue;
    }
    accepted.push({ proposal: parsed.data, caveats: verdict.caveats });
  }
  return { accepted, rejections, outputInvalid: false };
}
