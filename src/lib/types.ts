// Domain types. Field names follow docs/architecture/DATA_MODEL.md (camelCased).
// Every tenant row carries ownerId; all access goes through owner-scoped services.

/** 'live_test': the operator live test (tools/live-test) against approved hostnames. The web app only ever runs 'mock'. */
export type Mode = 'mock' | 'live' | 'live_test';

export type ActorKind = 'human' | 'system' | 'model';
export type Actor = { userId: string; kind: ActorKind };

export type IdentityStatus = 'unverified' | 'confirmed' | 'ambiguous' | 'confirmed_by_operator';

export type Business = {
  id: string;
  ownerId: string;
  normalizedName: string;
  displayName: string;
  domain: string | null;
  phone: string | null;
  address: string | null;
  city: string;
  state: string;
  category: string;
  externalIds: Record<string, string>;
  identityStatus: IdentityStatus;
  identityNotes: string[];
  /** true only for bundled fictional fixtures; never set for operator-entered businesses */
  synthetic: boolean;
  fixtureKey: string | null;
  possibleDuplicateOf: string | null;
  duplicateResolution: 'unresolved' | 'kept_separate' | 'marked_duplicate' | null;
  createdAt: string;
};

export type RunStatus =
  | 'queued'
  | 'resolving_identity'
  | 'collecting'
  | 'analyzing'
  | 'verifying'
  | 'review_ready'
  | 'blocked'
  | 'partial'
  | 'failed'
  | 'canceled';

export type StageKey = 'identity' | 'website' | 'public_signals' | 'evidence_review' | 'report';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'partial'
  | 'restricted'
  | 'failed'
  | 'not_checked';

export type StageState = { key: StageKey; status: StageStatus; note: string; updatedAt: string | null };

export type ErrorCode =
  | 'access_denied'
  | 'source_unavailable'
  | 'rate_limited'
  | 'identity_ambiguous'
  | 'extraction_failed'
  | 'model_invalid_output'
  | 'budget_exceeded'
  | 'security_blocked'
  | 'timeout'
  | 'duplicate_unresolved';

export type UnknownKind = 'website_not_inspected' | 'feature_not_concluded';
export type UnknownTopic = 'booking_link' | 'contact_form' | 'after_hours_statement';

/**
 * Something the investigation could not determine.
 *
 * `question` and `reason` are INTERNAL free text (they may name budgets,
 * fetch diagnostics or anything a future writer puts there). The owner report
 * never prints them: it rebuilds its own wording from the structured fields
 * below, and withholds any unknown that lacks them (see reports.ts).
 */
export type Unknown = {
  id: string;
  question: string;
  reason: string;
  sourceRecordIds: string[];
  kind?: UnknownKind;
  topic?: UnknownTopic | null;
  inspectedCount?: number;
  unreachedPlannedCount?: number;
  budgetExhausted?: boolean;
  /** pages that were fetched but could only be read in part (size limit, script-drawn page, embedded widget) */
  partiallyReadCount?: number;
};

export type InvestigationRun = {
  id: string;
  ownerId: string;
  businessId: string;
  status: RunStatus;
  stages: StageState[];
  startedAt: string | null;
  finishedAt: string | null;
  mode: Mode;
  queryScope: {
    maxPages: number;
    plannedPaths: string[] | null;
    /**
     * Set when the home page was served from a different origin of the same site
     * (for example "https://www.example.com" when "https://example.com" was asked for).
     * Inner pages are then requested there, under that origin's robots.txt.
     */
    canonicalBase?: string | null;
    canonicalRobots?: { status: 'ok' | 'none' | 'unreachable'; text: string | null } | null;
  };
  robots: { status: 'not_fetched' | 'ok' | 'none' | 'unreachable'; text: string | null };
  budgetExhausted: boolean;
  fixtureNotesSeeded: boolean;
  budgetCents: number;
  spentCents: number;
  requestCap: number;
  requestsUsed: number;
  retriesUsed: number;
  modelVersion: string;
  errorSummary: { code: ErrorCode; message: string }[];
  unknowns: Unknown[];
  idempotencyKey: string | null;
  createdAt: string;
};

export type AccessStatus = 'ok' | 'restricted' | 'unavailable' | 'error';
export type StorageClass = 'PUBLIC_BUSINESS' | 'RESTRICTED_SOURCE' | 'PERSONAL';
export type SourceType = 'website' | 'manual_observation';

export type SourceRecord = {
  id: string;
  ownerId: string;
  runId: string;
  businessId: string;
  sourceType: SourceType;
  /** null only for manual observations with no shareable link */
  sourceUrl: string | null;
  provider: string;
  retrievedAt: string;
  accessStatus: AccessStatus;
  accessDetail: string;
  permittedStorageClass: StorageClass;
  queryContext: Record<string, string | number | null>;
  checksum: string | null;
  notes: string;
  attempts: number;
  retryable: boolean;
  /** Bounded, derived facts only. Raw HTML is never stored. */
  extracted: PageExtract | null;
  synthetic: boolean;
};

export type PageExtract = {
  path: string;
  title: string;
  phones: string[];
  bookingLinks: { text: string; href: string }[];
  contactFormFieldCounts: number[];
  afterHours: string | null;
  phoneScheduling: string | null;
  hours: string | null;
  copyrightYear: number | null;
  instructionLike: string | null;
  /** Why the page could not be read in full (see PageFacts.readLimits). Missing on older rows. */
  readLimits?: string[];
};

export type EvidenceType =
  | 'phone_listed'
  | 'contact_form'
  | 'booking_link'
  | 'after_hours_statement'
  | 'phone_scheduling_statement'
  | 'hours_listed'
  | 'stale_marker'
  | 'instruction_like_text'
  | 'customer_comment'
  | 'owner_statement'
  | 'search_observation'
  | 'operator_observation';

export type Polarity = 'presence' | 'absence' | 'neutral';
export type IdentityMatch = 'confirmed' | 'uncertain' | 'mismatch';
export type VerificationStatus = 'needs_review' | 'accepted' | 'rejected' | 'needs_verification';
export type Sensitivity = 'public' | 'restricted' | 'personal';
export type Confidence = 'low' | 'medium' | 'high';
export type Stance = 'reports_problem' | 'reports_positive' | 'neutral';
export type Caveat = 'geo_uncertain' | 'anecdotal' | 'stale' | 'html_only' | 'site_may_be_outdated' | 'unencrypted_http';

export type Evidence = {
  id: string;
  ownerId: string;
  runId: string;
  sourceRecordIds: string[];
  businessId: string;
  evidenceType: EvidenceType;
  polarity: Polarity;
  observation: string;
  supportingExcerpt: string | null;
  locator: Record<string, string | number | string[] | null>;
  observedAt: string;
  identityMatchStatus: IdentityMatch;
  verificationStatus: VerificationStatus;
  reviewNote: string | null;
  sensitivity: Sensitivity;
  confidence: Confidence;
  confidenceRationale: string;
  caveats: Caveat[];
  topic: string | null;
  stance: Stance | null;
  dedupeKey: string;
  checksum: string;
  supersededBy: string | null;
  synthetic: boolean;
  createdAt: string;
};

export type OpportunityStatus = 'needs_review' | 'supported' | 'invalidated';
export type OpportunityDecision = 'pending' | 'accepted' | 'rejected';

export type Opportunity = {
  id: string;
  ownerId: string;
  runId: string;
  title: string;
  observedFact: string;
  interpretation: string;
  alternativeExplanations: string[];
  ownerQuestion: string;
  possibleFix: string;
  evidenceIds: string[];
  confidence: Confidence;
  caveats: Caveat[];
  status: OpportunityStatus;
  decision: OpportunityDecision;
  decisionReason: string | null;
  /**
   * What the reasoner was shown when it wrote this claim's text.
   * 'public_only': nothing but public, PUBLIC_BUSINESS-backed observations.
   * 'includes_restricted': restricted, personal or non-public material was in view.
   * Missing (older rows) is treated as not shareable.
   */
  reasonedFrom?: 'public_only' | 'includes_restricted';
  createdAt: string;
};

export type VerifierRejection = {
  id: string;
  ownerId: string;
  runId: string;
  code: string;
  message: string;
  proposalTitle: string;
  at: string;
};

export type ReportStatus = 'draft' | 'evidence_review' | 'approved_internal' | 'approved_to_share';

export type Report = {
  id: string;
  ownerId: string;
  runId: string;
  businessId: string;
  version: number;
  status: ReportStatus;
  approvedAt: string | null;
  approvedContentHash: string | null;
  sharedAt: string | null;
  /** exact owner-safe Markdown the operator approved for sharing */
  sharedSnapshot: string | null;
  sharedContentHash: string | null;
  createdAt: string;
};

export type OutreachStatus = 'draft' | 'approved' | 'sent_manual';

export type OutreachDraft = {
  id: string;
  ownerId: string;
  businessId: string;
  reportId: string;
  reportVersion: number;
  opportunityId: string;
  channel: 'email';
  subject: string;
  body: string;
  status: OutreachStatus;
  approvedAt: string | null;
  approvalId: string | null;
  copiedAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type Approval = {
  id: string;
  ownerId: string;
  action: 'outreach_manual_send';
  targetId: string;
  recipient: string;
  contentHash: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  ownerId: string;
  actorKind: ActorKind;
  action: string;
  targetType: string;
  targetId: string;
  /** short, non-sensitive description; never source bodies or secrets */
  detail: string;
  at: string;
};

export type Notice = { id: string; kind: 'ok' | 'error'; text: string };
export type User = { id: string; label: string; createdAt: string; notice: Notice | null };
export type Session = {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  /** Missing on sessions created before sign-in required a credential; those are not honoured. */
  lastSeenAt?: string;
  idleMinutes?: number;
};

/** Sign-in state. Only hashes are stored: never the passphrase, never the setup code. */
export type AuthState = {
  credential: { hash: string; createdAt: string; updatedAt: string } | null;
  setup: { codeHash: string; createdAt: string } | null;
};
export type LoginAttempt = { key: string; at: string };

export type Db = {
  auth: AuthState;
  users: User[];
  sessions: Session[];
  loginAttempts: LoginAttempt[];
  businesses: Business[];
  runs: InvestigationRun[];
  sourceRecords: SourceRecord[];
  evidence: Evidence[];
  opportunities: Opportunity[];
  verifierRejections: VerifierRejection[];
  reports: Report[];
  outreachDrafts: OutreachDraft[];
  approvals: Approval[];
  auditEvents: AuditEvent[];
};

export function emptyDb(): Db {
  return {
    auth: { credential: null, setup: null },
    users: [],
    sessions: [],
    loginAttempts: [],
    businesses: [],
    runs: [],
    sourceRecords: [],
    evidence: [],
    opportunities: [],
    verifierRejections: [],
    reports: [],
    outreachDrafts: [],
    approvals: [],
    auditEvents: [],
  };
}
