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

export type EngagementTemplateKey = 'letter_of_authority' | 'client_care_letter' | 'fee_agreement';
export type EngagementDocumentState = 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'expired' | 'verified';
export type SignerRole = 'client' | 'representative' | 'director' | 'officer';
export type SignatureMethod = 'wet_signature_upload' | 'portal_drawn' | 'provider_electronic';

export interface EngagementTemplate {
  id: string;
  templateKey: EngagementTemplateKey;
  title: string;
  version: number;
  bodyMarkdown: string;
  allowedFields: string[];
  isActive: boolean;
  createdBy: { accountId: string; displayName: string } | null;
  createdAt: Date;
}

export interface EngagementSignatureReview {
  id: string;
  signatureId: string;
  outcome: 'accepted' | 'rejected';
  reason: string;
  reviewedBy: { accountId: string; displayName: string };
  reviewedAt: Date;
}

export interface EngagementSignature {
  id: string;
  engagementDocumentId: string;
  signerName: string;
  signerEmail: string | null;
  signerRole: SignerRole;
  signatureMethod: SignatureMethod;
  documentId: string | null;
  rawMetadata: Record<string, unknown>;
  signedAt: Date;
  recordedBy: { accountId: string; displayName: string };
  recordedAt: Date;
  review?: EngagementSignatureReview | null;
}

export interface EngagementDocument {
  id: string;
  clientId: string;
  matterId: string | null;
  templateId: string;
  templateVersion: number;
  title: string;
  documentKind: EngagementTemplateKey;
  state: EngagementDocumentState;
  inputSnapshot: Record<string, unknown>;
  renderedContent: string;
  contentHash: string;
  generatedBy: { accountId: string; displayName: string };
  generatedAt: Date;
  sentAt: Date | null;
  viewedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  expiresAt: Date | null;
  signature?: EngagementSignature | null;
}

export type MatterChargingBasis = 'fixed' | 'hourly' | 'contingency' | 'capped' | 'pro_bono';
export type MatterFeeEstimateStatus = 'active' | 'superseded';

export interface MatterFeeEstimate {
  id: string;
  matterId: string;
  clientId: string;
  version: number;
  chargingBasis: MatterChargingBasis;
  estimatedFeesPence: string;
  estimatedDisbursementsPence: string;
  estimatedVatPence: string;
  totalEstimatePence: string;
  budgetLimitPence: string | null;
  currency: string;
  assumptions: string;
  status: MatterFeeEstimateStatus;
  agreedWithClient: boolean;
  createdBy: { accountId: string; displayName: string };
  createdAt: Date;
}

export type OnboardingPaymentRequestKind = 'deposit_on_account' | 'initial_fixed_fee' | 'consultation';
export type OnboardingPaymentRequestStatus = 'pending' | 'paid' | 'waived' | 'cancelled';
export type OnboardingPaymentMethod = 'bank_transfer' | 'card' | 'portal_checkout' | 'cheque' | 'cash';

export interface BankAccountDetails {
  accountName: string;
  sortCode: string;
  accountNumber: string;
  bankName: string;
  reference?: string;
}

export interface OnboardingPaymentRequest {
  id: string;
  clientId: string;
  matterId: string | null;
  engagementDocumentId: string | null;
  reference: string;
  kind: OnboardingPaymentRequestKind;
  description: string;
  amountPence: string;
  currency: string;
  dueOn: string;
  status: OnboardingPaymentRequestStatus;
  paymentMethod: OnboardingPaymentMethod | null;
  paidAt: Date | null;
  paidReference: string | null;
  bankAccountDetails: Record<string, unknown> | null;
  notes: string | null;
  requestedBy: { accountId: string; displayName: string };
  requestedAt: Date;
  updatedBy?: { accountId: string; displayName: string } | null;
  updatedAt?: Date | null;
}

export interface PortalPaymentRequest {
  id: string;
  reference: string;
  kind: OnboardingPaymentRequestKind;
  description: string;
  amountPence: string;
  currency: string;
  dueOn: string;
  status: OnboardingPaymentRequestStatus;
  bankAccountDetails: Record<string, unknown> | null;
  paidAt: Date | null;
  paidReference: string | null;
}

