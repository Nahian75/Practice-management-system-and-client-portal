export interface ComplianceAccess { canRestricted: boolean; attentionCount: number }

export interface ComplianceGate {
  state: 'pending' | 'cleared' | 'review_due' | 'held';
  dueSince: string | null;
  workAllowedUntil: string | null;
  clearanceId: string | null;
}

export interface CddSummary {
  id: string;
  version: number;
  status: 'draft' | 'submitted' | 'abandoned';
  preparedBy: { id: string; displayName: string };
  createdAt: string;
  submittedAt: string | null;
  subjectCount: number;
  evidenceCount: number;
}

export interface CddSubject {
  id: string;
  kind: 'individual' | 'legal_entity';
  relationship: 'client' | 'authorised_representative' | 'director_senior_manager' | 'beneficial_owner' |
    'trustee' | 'settlor' | 'beneficiary' | 'protector' | 'funder' | 'other_controller';
  details: Record<string, unknown>;
  recordedAt: string;
}

export interface CddEvidence {
  id: string; evidenceType: string; country: string | null; issuedOn: string | null; expiresOn: string | null;
  fileName: string; documentIdentifier: string | null; providerPayloadHash: string | null;
  mediaType: string; sizeBytes: number; uploadedAt: string;
}

export interface CddCase {
  id: string; clientId: string; version: number; status: 'draft' | 'submitted' | 'abandoned';
  intendedRelationship: string; reason: string; preparedBy: { accountId: string; displayName: string };
  createdAt: string; submittedAt: string | null;
  abandonment: { by: { accountId: string; displayName: string }; at: string; reason: string } | null;
  controls: Array<{ id: string; kind: string; version: number }>;
  subjects: CddSubject[]; evidence: CddEvidence[];
  ownership: Array<{ id: string; ownedSubjectId: string; controllerSubjectId: string; ownershipPercent: string | null;
    controlKind: string; details: string; recordedAt: string }>;
  authorities: Array<{ id: string; representativeSubjectId: string; representedSubjectId: string; evidenceId: string;
    authorityType: string; verifiedOn: string; details: string; recordedAt: string }>;
  verifications: Array<{ id: string; subjectId: string; evidenceId: string; sourceType: string; country: string | null;
    checkedOn: string; expiresOn: string | null; method: string; outcome: string; provider: string | null;
    service: string | null; documentIdentifier: string | null; providerResult: string | null; verifiedAt: string }>;
}

export interface RiskSummary {
  id: string;
  version: number;
  inScope: boolean;
  rating: 'low' | 'standard' | 'high';
  reviewDueOn: string;
  preparedBy: { id: string; displayName: string };
  submittedAt: string;
}

export interface RiskAssessment extends RiskSummary {
  matterId: string; clientId: string; cddCaseId: string | null; countryListVersionId: string;
  expectedValue: 'none' | 'under_10k' | '10k_to_100k' | '100k_to_1m' | 'over_1m';
  reviewGraceDays: number; lowersPrevious: boolean; jurisdictions: string[];
  factors: Record<string, boolean>; narrative: Record<string, string | null>;
}

export interface AssessmentWork {
  assessmentId: string;
  measures: Array<{ id: string; kind: string; enhanced: boolean; description: string;
    recordedBy: { accountId: string; displayName: string }; recordedAt: string;
    results: Array<{ id: string; outcome: 'satisfied' | 'not_satisfied'; evidenceIds: string[]; reasoning: string;
      recordedBy: { accountId: string; displayName: string }; recordedAt: string }> }>;
  conclusions: Array<{ id: string; kind: 'funds' | 'wealth'; subjectId: string | null; amountMinPence: string;
    amountMaxPence: string; outcome: 'satisfied' | 'not_satisfied'; evidenceIds: string[]; reasoning: string;
    recordedBy: { accountId: string; displayName: string }; recordedAt: string }>;
}

export interface AmlClearance {
  id: string; matterId: string; assessmentId: string; decision: 'approved' | 'refused'; needsSenior: boolean;
  reliedMeasureResults: string[]; reliedConclusions: string[]; reasoning: string;
  decidedBy: { accountId: string; displayName: string }; decidedAt: string;
  seniorApproval: { approvedBy: { accountId: string; displayName: string }; approvedAt: string } | null;
}

export interface ReviewQueueItem {
  matterId: string;
  reference: string;
  state: 'pending' | 'cleared' | 'review_due' | 'held';
  dueSince: string | null;
  workAllowedUntil: string | null;
  reviewDueOn: string | null;
}

export interface ComplianceHold {
  id: string;
  clientId: string;
  matterId: string | null;
  reason: string;
  imposedBy: { id: string; displayName: string };
  imposedAt: string;
  lift: { reason: string; liftedBy: { id: string; displayName: string }; liftedAt: string } | null;
}

export interface SanctionsStatus {
  listId: string | null;
  version: number | null;
  reportDate: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  fresh: boolean;
}

export interface SanctionsCandidate {
  candidateId: string;
  clientId: string;
  clientReference: string;
  subjectRef: string;
  uniqueId: string;
  matchedName: string;
  birthAgreement: 'match' | 'conflict' | 'unknown';
  screenedAt: string;
}

export interface RetentionScheduleSummary {
  id: string;
  clientId: string;
  relationshipEndedOn: string;
  retentionYears: number;
  disposeAfter: string;
  governingRule: string;
  currentHold: { action: 'imposed' | 'reviewed' | 'released'; reviewOn: string | null } | null;
  recordedBy: string;
  recordedAt: string;
}

export interface LegalHoldEvent {
  id: string;
  action: 'imposed' | 'reviewed' | 'released';
  reviewOn: string | null;
  authority: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface RetentionSchedule extends Omit<RetentionScheduleSummary, 'currentHold'> {
  evidence: string;
  holds: LegalHoldEvent[];
}

export interface DisposalRun {
  id: string;
  scheduleId: string;
  clientId: string;
  governingRule: string;
  state: 'prepared' | 'completed';
  preparedBy: string;
  preparedAt: string;
  completedBy: string | null;
  completedAt: string | null;
  recordCount: number | null;
}

export interface RegulatoryExport {
  id: string;
  clientId: string;
  sha256: string;
  byteSize: number;
  createdBy: string;
  createdAt: string;
}

export interface RestrictedReportSummary {
  id: string;
  observedOn: string;
  submittedAt: string;
  decided: boolean;
}

export interface RestrictedReport {
  id: string;
  clientId: string;
  matterId: string | null;
  financeTransactionId: string | null;
  observedOn: string;
  observedFacts: string;
  submittedBy: string;
  submittedAt: string;
  attachments: Array<{ id: string; fileName: string; mediaType: string; sizeBytes: number; uploadedAt: string }>;
  decision: { id: string; externalReportRequired: boolean; legalGrounds: string; decidedBy: string; decidedAt: string } | null;
  externalReport: {
    id: string;
    kind: 'sar' | 'terrorist_financing_report';
    damlDatfRequested: boolean;
    reference: string;
    submittedAt: string;
    recordedAt: string;
    submittedBy: string;
    events: Array<{ id: string; outcome: 'requested' | 'granted' | 'refused' | 'withdrawn' | 'expired';
      receivedAt: string; expiresAt: string | null; externalReference: string; permittedActivity: string | null;
      legalBasis: string; recordedBy: string; recordedAt: string }>;
  } | null;
}
