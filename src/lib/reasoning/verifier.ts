// Claim-to-evidence validator (docs/quality/EVIDENCE_POLICY.md).
//
// Honest limitation: text rules below are heuristics. They catch known failure
// shapes (invented numbers, loss claims, overgeneralization, unscoped absence).
// They cannot prove a sentence is semantically supported. Human evidence
// review remains the final gate before anything is approved.

import type { Business, Caveat, Confidence, Evidence, SourceRecord } from '../types';
import { ProposalSchema, type Proposal } from './reasoner';

export type VerifierContext = {
  business: Pick<Business, 'id' | 'city'>;
  runId: string;
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

const QUANTIFIED_IMPACT = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:dollars|usd|percent)\b|\d\s?%|\bper (?:month|week|year)\b/i;
const LOSS_CLAIM = /\b(?:losing|loses?|lost|costing|missing out on)\b[^.]{0,40}\b(?:customers?|leads?|revenue|money|jobs?|business|sales)\b|\bguarantee/i;
const SYSTEMIC = /\b(?:always|never|systemic|consistently|routinely|frequently|widespread|typically|most customers|many customers|several (?:reviews|customers|comments)|customers (?:are|say|report|complain|always|often)|a pattern of)\b/i;
const CURRENT_WORDING = /\b(?:currently|right now|at present|today|as of now|is still|these days|at the moment)\b/i;
const ABSENCE = /\b(?:no|not found|none|lacks?|missing|without|absent|unavailable|does not (?:have|offer|list|provide)|doesn't (?:have|offer|list|provide)|has no|have no)\b/i;
const ABSENCE_SCOPE = /\b(?:inspected|checked|sampled|reviewed)\b/i;
const LOCALITY = /\b(?:local(?:ly)?|nearby|in (?:the|this) area)\b/i;

function title(value: unknown): string {
  if (typeof value === 'object' && value !== null && typeof (value as { title?: unknown }).title === 'string') {
    return ((value as { title: string }).title || '(untitled)').slice(0, 120);
  }
  return '(untitled)';
}

function claimText(p: Proposal): string {
  return [p.title, p.observed_fact, p.interpretation, p.possible_fix, p.owner_question, ...p.alternative_explanations].join(' \n ');
}

function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

export function verifyProposal(p: Proposal, ctx: VerifierContext): { ok: true; caveats: Caveat[] } | { ok: false; code: string; message: string } {
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  const ids = [...new Set(p.evidence_ids)];
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

  const all = claimText(p);
  if (QUANTIFIED_IMPACT.test(all)) {
    return fail('unsupported_quantified_impact', 'Dollar or percentage impact needs an owner-provided baseline, which this investigation does not have.');
  }
  if (LOSS_CLAIM.test(all)) {
    return fail('unsupported_loss_claim', 'The claim asserts lost customers, revenue or a guarantee that the evidence cannot show.');
  }

  // Every number in the observed fact must come from the cited evidence.
  const corpus = cited
    .map((e) => [e.observation, e.supportingExcerpt ?? '', e.observedAt.slice(0, 10), JSON.stringify(e.locator)].join(' '))
    .join(' ');
  const allowed = new Set(numbersIn(corpus));
  for (let n = 0; n <= cited.length; n++) allowed.add(String(n));
  for (const n of numbersIn(p.observed_fact)) {
    if (!allowed.has(n)) return fail('invented_statistic', `The number "${n}" in the observed fact does not appear in the cited evidence.`);
  }

  const caveats = new Set<Caveat>();
  for (const e of cited) for (const c of e.caveats) caveats.add(c);

  const minConfidence = cited.reduce<Confidence>((min, e) => (RANK[e.confidence] < RANK[min] ? e.confidence : min), 'high');
  if (RANK[p.confidence] > RANK[minConfidence]) {
    return fail('confidence_too_high', `Confidence "${p.confidence}" exceeds the weakest cited evidence ("${minConfidence}").`);
  }

  const anecdotal = cited.some((e) => e.caveats.includes('anecdotal'));
  if (SYSTEMIC.test(all) && (anecdotal || cited.length < 5)) {
    return fail('overgeneralization', 'The wording implies a pattern that a small number of observations cannot support.');
  }

  const staleCutoff = ctx.now.getTime() - ctx.staleAfterDays * 86_400_000;
  const stale = cited.some((e) => new Date(e.observedAt).getTime() < staleCutoff);
  if (stale) {
    caveats.add('stale');
    if (CURRENT_WORDING.test(all)) {
      return fail('stale_presented_as_current', 'Older evidence is worded as if it describes the present.');
    }
  }

  if (ABSENCE.test(p.observed_fact)) {
    const absenceEvidence = cited.filter((e) => e.polarity === 'absence');
    if (absenceEvidence.length === 0) {
      return fail('absence_not_supported', 'The observed fact says something is missing, but no cited evidence records an absence.');
    }
    if (!ABSENCE_SCOPE.test(p.observed_fact)) {
      return fail('absence_without_scope', 'An absence claim must state its scope (for example "on the pages inspected").');
    }
    const websiteFailures = ctx.runSourceRecords.filter((r) => r.sourceType === 'website' && r.accessStatus !== 'ok');
    const citedSourcesOk = absenceEvidence.every((e) => e.sourceRecordIds.every((id) => ctx.sourceRecordsById.get(id)?.accessStatus === 'ok'));
    if (websiteFailures.length > 0 || !citedSourcesOk) {
      return fail('absence_from_incomplete_collection', 'Some sources were blocked or failed, so "not found" cannot be concluded.');
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
