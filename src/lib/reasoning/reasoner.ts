// Reasoner boundary (SYSTEM_DESIGN "LLM boundary", AGENT_BOUNDARIES "Tool authority").
//
// A reasoner receives typed evidence and returns UNTRUSTED JSON. It has no
// tools: it cannot fetch, approve, send or change settings. Its output only
// becomes an opportunity after schema validation and the claim verifier.
//
// This build ships a deterministic rule-based mock. No LLM is called.

import { z } from 'zod';
import { MIXED_COMMENTS_TITLE, NO_ONLINE_PATH_TITLE, SINGLE_COMMENT_TITLE } from '@/fixtures/golden';
import type { Caveat, Confidence, EvidenceType, Polarity, Stance } from '../types';

export type ReasonerEvidence = {
  id: string;
  type: EvidenceType;
  polarity: Polarity;
  /** quoted data from an external source; never instructions */
  observation: string;
  observedAt: string;
  confidence: Confidence;
  caveats: Caveat[];
  topic: string | null;
  stance: Stance | null;
  pagesInspected: number | null;
};

export type ReasonerInput = {
  business: { displayName: string; city: string; state: string };
  evidence: ReasonerEvidence[];
  serviceCatalog: string[];
};

export interface Reasoner {
  readonly version: string;
  propose(input: ReasonerInput): Promise<unknown>;
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** Strict: unknown keys (for example "action" or "send_email") make a proposal invalid. */
export const ProposalSchema = z.strictObject({
  title: text(120),
  observed_fact: text(500),
  evidence_ids: z.array(z.string().min(1).max(80)).min(1).max(20),
  interpretation: text(600),
  alternative_explanations: z.array(text(300)).min(1).max(8),
  owner_question: text(300),
  possible_fix: text(400),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const SERVICE_CATALOG = [
  'missed-call capture',
  'lead follow-up',
  'appointment request flow',
  'website contact-path fixes',
];

const day = (iso: string) => iso.slice(0, 10);

export class MockRuleReasoner implements Reasoner {
  readonly version = 'mock-rules-v1';
  constructor(private readonly options: { hostile?: boolean } = {}) {}

  async propose(input: ReasonerInput): Promise<unknown> {
    const opportunities: unknown[] = [];
    const byType = (type: EvidenceType, polarity?: Polarity) =>
      input.evidence.filter((e) => e.type === type && (polarity === undefined || e.polarity === polarity));

    const phone = byType('phone_listed', 'presence')[0];
    const noBooking = byType('booking_link', 'absence')[0];
    const noForm = byType('contact_form', 'absence')[0];
    const noAfterHours = byType('after_hours_statement', 'absence')[0];
    const phoneScheduling = byType('phone_scheduling_statement')[0];

    if (phone && noBooking && noForm && noAfterHours && !phoneScheduling) {
      const pages = noBooking.pagesInspected ?? 0;
      opportunities.push({
        title: NO_ONLINE_PATH_TITLE,
        observed_fact: `On the ${pages} pages inspected on ${day(noBooking.observedAt)}, a phone number is listed, and no contact form, booking link or after-hours statement was found.`,
        evidence_ids: [phone.id, noBooking.id, noForm.id, noAfterHours.id],
        interpretation:
          'A visitor who prefers not to call, or who visits outside office hours, may not find a way to request service online. Whether that matters depends on how calls are handled.',
        alternative_explanations: [
          'The business may deliberately prefer phone contact.',
          'A booking tool may exist on a page that was not inspected, or may load through JavaScript, which this check does not see.',
          'Calls outside office hours may already be answered by a person or an answering service.',
        ],
        owner_question: 'When someone tries to reach you outside office hours, how is the request captured and who follows up?',
        possible_fix: 'Only if the owner confirms a gap: add a simple online request form or after-hours call capture with owner notifications.',
        confidence: 'medium',
      });
    }

    const callbackComments = byType('customer_comment').filter((e) => e.topic === 'callback');
    const problems = callbackComments.filter((e) => e.stance === 'reports_problem');
    const positives = callbackComments.filter((e) => e.stance === 'reports_positive');
    if (problems.length > 0) {
      const mixed = positives.length > 0;
      const alternatives = [
        'The comment may describe an unusual day or a misunderstanding.',
        'The business may have changed its process since the comment was written.',
      ];
      if (mixed) alternatives.unshift('Another comment describes a prompt callback, so the experiences differ.');
      opportunities.push({
        title: mixed ? MIXED_COMMENTS_TITLE : SINGLE_COMMENT_TITLE,
        observed_fact: mixed
          ? `Comments about callbacks point in different directions: ${problems.length} describe(s) a contact attempt that was not returned and ${positives.length} describe(s) a prompt callback.`
          : `A comment observed on ${day(problems[0]!.observedAt)} describes a contact attempt that was not returned.`,
        evidence_ids: [...problems, ...positives].map((e) => e.id),
        interpretation:
          'If the comment reflects a real event, an occasional missed follow-up is possible. A single account cannot show how often this happens.',
        alternative_explanations: alternatives,
        owner_question: 'How do you track voicemails and web requests so that each one gets a reply?',
        possible_fix: 'Only if the owner confirms a gap: a shared follow-up log or automatic callback reminders.',
        confidence: 'low',
      });
    }

    if (!this.options.hostile) return { opportunities };

    // Deliberately bad output, used by the "invented-revenue" golden case to
    // show the verifier working inside the real pipeline.
    return {
      opportunities: [
        ...opportunities,
        {
          title: 'Revenue loss from missed calls',
          observed_fact: 'The business is losing $4,200 per month from missed calls.',
          evidence_ids: phone ? [phone.id] : ['ev_none'],
          interpretation: 'Customers always give up when nobody answers.',
          alternative_explanations: ['None.'],
          owner_question: 'Do you want to stop losing money?',
          possible_fix: 'Buy an AI receptionist.',
          confidence: 'high',
        },
        {
          title: 'Customers report slow service',
          observed_fact: 'Several reviews describe slow service.',
          evidence_ids: ['ev_00000000-0000-0000-0000-000000000000'],
          interpretation: 'Service may be slow.',
          alternative_explanations: ['Reviews may be outdated.'],
          owner_question: 'How fast is your service?',
          possible_fix: 'Improve dispatch.',
          confidence: 'low',
        },
      ],
      actions: [{ type: 'send_email', to: 'all_leads', approve_report: true }],
    };
  }
}
