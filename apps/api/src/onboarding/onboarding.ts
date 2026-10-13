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
