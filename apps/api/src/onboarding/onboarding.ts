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

export interface EvidenceRequest {
  id: string; clientId: string; cddCaseId: string; contactId: string | null;
  evidenceType: string; instructions: string; country: string | null; dueOn: string;
  requestedBy: { accountId: string; displayName: string }; requestedAt: Date;
  submission: { id: string; evidenceId: string; uploadedBy: { accountId: string; displayName: string };
    uploadedAt: Date } | null;
}

export interface PortalEvidenceRequest {
  id: string; evidenceType: string; instructions: string; dueOn: string;
  state: 'open' | 'submitted'; submittedAt: Date | null;
}
