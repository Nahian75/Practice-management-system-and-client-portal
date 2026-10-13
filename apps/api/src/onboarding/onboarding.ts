export type ContactVerificationState = 'pending' | 'verified' | 'expired' | 'superseded' | 'address_changed';

export interface ContactVerification {
  id: string;
  clientId: string;
  contactId: string | null;
  channel: 'email';
  address: string;
  state: ContactVerificationState;
  attemptCount: number;
  requestedBy: { accountId: string; displayName: string };
  requestedAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
}

export interface EvidenceReview {
  id: string;
  requestId: string;
  evidenceId: string;
  outcome: 'accepted' | 'rejected';
  reason: string;
  exceptionNote: string | null;
  reviewedBy: { accountId: string; displayName: string };
  reviewedAt: Date;
}

export interface EvidenceRequest {
  id: string; clientId: string; cddCaseId: string; contactId: string | null;
  evidenceType: string; instructions: string; country: string | null; dueOn: string;
  requestedBy: { accountId: string; displayName: string }; requestedAt: Date;
  submission: {
    id: string; evidenceId: string; uploadedBy: { accountId: string; displayName: string };
    uploadedAt: Date;
  } | null;
  review: EvidenceReview | null;
}

export interface PortalEvidenceRequest {
  id: string; evidenceType: string; instructions: string; dueOn: string;
  state: 'open' | 'submitted'; submittedAt: Date | null;
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
  recordedAt: Date;
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
  retrievedAt: Date;
  recordedBy: { accountId: string; displayName: string };
}

export interface ConflictAlias {
  id: string;
  clientId: string;
  name: string;
  kind: 'alias' | 'former_name' | 'trading_name';
  notes: string | null;
  createdBy: { accountId: string; displayName: string };
  createdAt: Date;
}

export interface ConflictConnectedPerson {
  id: string;
  clientId: string;
  name: string;
  relationship: 'director' | 'shareholder' | 'beneficial_owner' | 'connected_person' | 'counterparty' | 'officer' | 'guarantor';
  companyName: string | null;
  notes: string | null;
  createdBy: { accountId: string; displayName: string };
  createdAt: Date;
}

export interface ConflictDecision {
  id: string;
  checkId: string;
  clientId: string;
  outcome: 'clear' | 'potential' | 'escalated' | 'approved_with_controls' | 'cannot_act';
  rationale: string;
  safeguards: string[];
  decidedBy: { accountId: string; displayName: string };
  decidedAt: Date;
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
  expiresAt: Date;
  grantedBy: { accountId: string; displayName: string };
  grantedAt: Date;
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

