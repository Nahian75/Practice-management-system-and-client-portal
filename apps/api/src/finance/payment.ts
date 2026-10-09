import type { FinancePerson } from './finance.js';

export type PaymentKind = 'refund' | 'third_party' | 'costs_transfer';
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid' | 'bank_rejected';

export interface PaymentEvent {
  id: string;
  kind: Exclude<PaymentStatus, 'pending'>;
  reason: string | null;
  bankReference: string | null;
  occurredOn: string | null;
  financeTransactionId: string | null;
  actedBy: FinancePerson;
  actedAt: Date;
}

export interface PaymentRequest {
  id: string;
  kind: PaymentKind;
  clientId: string;
  matterId: string;
  clientBankAccountId: string;
  businessBankAccountId: string | null;
  billId: string | null;
  evidenceDocumentId: string;
  purpose: string;
  amountPence: string;
  requestedBy: FinancePerson;
  requestedAt: Date;
  status: PaymentStatus;
  events: PaymentEvent[];
}
