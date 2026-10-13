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
  createdAt: string;
}

export interface EngagementSignatureReview {
  id: string;
  signatureId: string;
  outcome: 'accepted' | 'rejected';
  reason: string;
  reviewedBy: { accountId: string; displayName: string };
  reviewedAt: string;
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
  signedAt: string;
  recordedBy: { accountId: string; displayName: string };
  recordedAt: string;
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
  generatedAt: string;
  sentAt: string | null;
  viewedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  expiresAt: string | null;
  signature?: EngagementSignature | null;
}

export type MatterChargingBasis = 'fixed' | 'hourly' | 'contingency' | 'capped' | 'pro_bono';
export type MatterFeeEstimateStatus = 'active' | 'superseded';

export const CHARGING_BASIS_LABELS: Record<MatterChargingBasis, string> = {
  fixed: 'Fixed fee',
  hourly: 'Hourly rates',
  contingency: 'Damages-based / contingency',
  capped: 'Capped fee',
  pro_bono: 'Pro bono',
};

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
  createdAt: string;
}

export type OnboardingPaymentRequestKind = 'deposit_on_account' | 'initial_fixed_fee' | 'consultation';
export type OnboardingPaymentRequestStatus = 'pending' | 'paid' | 'waived' | 'cancelled';
export type OnboardingPaymentMethod = 'bank_transfer' | 'card' | 'portal_checkout' | 'cheque' | 'cash';

export const PAYMENT_KIND_LABELS: Record<OnboardingPaymentRequestKind, string> = {
  deposit_on_account: 'Deposit on account (client money)',
  initial_fixed_fee: 'Initial fixed fee (office money)',
  consultation: 'Initial consultation fee',
};

export const PAYMENT_METHOD_LABELS: Record<OnboardingPaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  card: 'Debit / credit card',
  portal_checkout: 'Portal checkout',
  cheque: 'Cheque',
  cash: 'Cash (office receipt)',
};

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
  paidAt: string | null;
  paidReference: string | null;
  bankAccountDetails: Record<string, unknown> | null;
  notes: string | null;
  requestedBy: { accountId: string; displayName: string };
  requestedAt: string;
  updatedBy?: { accountId: string; displayName: string } | null;
  updatedAt?: string | null;
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
  paidAt: string | null;
  paidReference: string | null;
}

export function penceToPounds(pence: string | number | bigint): string {
  const p = BigInt(pence);
  const negative = p < 0n;
  const abs = negative ? -p : p;
  const whole = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '−' : ''}£${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

export function poundsToPence(poundsStr: string): bigint {
  const clean = poundsStr.trim().replace(/^£/, '').replace(/,/g, '');
  if (!clean) return 0n;
  const parts = clean.split('.');
  const whole = parts[0] || '0';
  const fraction = parts[1] || '0';
  const wholePence = BigInt(whole) * 100n;
  const fracPence = BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  return wholePence + fracPence;
}

