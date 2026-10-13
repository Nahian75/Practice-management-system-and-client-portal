export interface EvidenceReview {
  id: string;
  requestId: string;
  evidenceId: string;
  outcome: 'accepted' | 'rejected';
  reason: string;
  exceptionNote: string | null;
  reviewedBy: { accountId: string; displayName: string };
  reviewedAt: string;
}

export interface EvidenceRequest {
  id: string;
  clientId: string;
  cddCaseId: string;
  contactId: string | null;
  evidenceType: string;
  instructions: string;
  country: string | null;
  dueOn: string;
  requestedBy: { accountId: string; displayName: string };
  requestedAt: string;
  submission: {
    id: string;
    evidenceId: string;
    uploadedBy: { accountId: string; displayName: string };
    uploadedAt: string;
  } | null;
  review: EvidenceReview | null;
}

export interface ElectronicCheck {
  id: string;
  clientId: string;
  cddCaseId: string | null;
  provider: string;
  service: string;
  providerReference: string;
  documentType: string;
  checkDate: string;
  result: 'pass' | 'refer' | 'fail';
  livenessResult: 'pass' | 'refer' | 'fail' | 'not_checked' | null;
  evidenceMatch: string | null;
  exceptionNote: string | null;
  rawResponseHash: string;
  recordedBy: { accountId: string; displayName: string };
  recordedAt: string;
}

export interface CompanyDiscrepancy {
  field: string;
  clientValue?: unknown;
  companiesHouseValue?: unknown;
  description: string;
}

export interface CompanySnapshot {
  id: string;
  clientId: string;
  cddCaseId: string | null;
  source: 'companies_house' | 'overseas_registry' | 'manual_evidence';
  companyNumber: string;
  companyName: string;
  companyStatus: string;
  companyType: string | null;
  jurisdiction: string | null;
  incorporationDate: string | null;
  registeredOffice: Record<string, unknown>;
  officers: unknown[];
  discrepancies: CompanyDiscrepancy[];
  rawPayloadHash: string;
  retrievedAt: string;
  recordedBy: { accountId: string; displayName: string };
}

export interface ConflictAlias {
  id: string;
  clientId: string;
  name: string;
  kind: 'alias' | 'former_name' | 'trading_name';
  notes: string | null;
  createdBy: { accountId: string; displayName: string };
  createdAt: string;
}

export interface ConflictConnectedPerson {
  id: string;
  clientId: string;
  name: string;
  relationship: 'director' | 'shareholder' | 'beneficial_owner' | 'connected_person' | 'counterparty' | 'officer' | 'guarantor';
  companyName: string | null;
  notes: string | null;
  createdBy: { accountId: string; displayName: string };
  createdAt: string;
}

export interface ConflictDecision {
  id: string;
  checkId: string;
  clientId: string;
  outcome: 'clear' | 'potential' | 'escalated' | 'approved_with_controls' | 'cannot_act';
  rationale: string;
  safeguards: string[];
  decidedBy: { accountId: string; displayName: string };
  decidedAt: string;
}

export interface ClientConflictCheck {
  id: string;
  clientId: string;
  names: string[];
  matchCount: number;
  matches: {
    checkedName: string;
    matchedName: string;
    relation: string;
    clientId: string;
    matterId: string | null;
    score: number;
  }[];
  createdAt: string;
  requestedBy: { accountId: string; displayName: string };
}

export interface ActivationRequirement {
  key: string;
  title: string;
  status: 'satisfied' | 'pending' | 'blocked' | 'exception';
  details: string;
  reviewer?: string | null;
  lastEventAt?: string | null;
}

export interface ActivationException {
  id: string;
  clientId: string;
  requirementKey: 'conflict_check' | 'email_verification' | 'id_verification' | 'cdd_compliance';
  reason: string;
  expiresAt: string;
  grantedBy: { accountId: string; displayName: string };
  grantedAt: string;
}

export interface ActivationGate {
  status: 'pending' | 'ready' | 'activated' | 'blocked';
  canActivate: boolean;
  isActivated: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
  notes: string | null;
  requirements: ActivationRequirement[];
}

