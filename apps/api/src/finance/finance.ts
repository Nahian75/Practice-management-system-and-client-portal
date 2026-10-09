export interface FinancePerson {
  accountId: string;
  displayName: string;
}

export interface RateAccount extends FinancePerson {
  roles: ('partner' | 'fee_earner')[];
}

export interface StaffRate {
  id: string;
  account: FinancePerson;
  hourlyRatePence: string;
  effectiveFrom: string;
  createdBy: FinancePerson;
  createdAt: Date;
}

export interface TimeValues {
  workedOn: string;
  minutes: number;
  description: string;
  hourlyRatePence: string;
}

export interface TimeCorrection {
  id: string;
  from: TimeValues;
  to: TimeValues | null;
  reason: string;
  correctedBy: FinancePerson;
  correctedAt: Date;
}

export interface TimeEntry extends TimeValues {
  id: string;
  matterId: string;
  worker: FinancePerson;
  voided: boolean;
  recordedAt: Date;
  corrections: TimeCorrection[];
}

export type BillLineKind = 'fee' | 'recharge' | 'disbursement';
export type VatTreatment = 'standard' | 'reduced' | 'zero' | 'exempt' | 'outside_scope';

export interface SupplierSnapshot {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  town: string;
  postcode: string | null;
  country: string;
  vatRegistrationNumber: string | null;
}

export interface BillLineInput {
  kind: BillLineKind;
  description: string;
  netPence: string;
  vatTreatment: VatTreatment;
  timeEntryId: string | null;
}

export interface BillLine extends BillLineInput {
  id: string;
  position: number;
  vatPence: string;
  grossPence: string;
  time?: { workerName: string; workedOn: string; minutes: number; hourlyRatePence: string };
}

export interface BillDraft {
  id: string;
  matterId: string;
  status: 'draft';
  taxPoint: string;
  dueOn: string;
  supplier: SupplierSnapshot;
  netPence: string;
  vatPence: string;
  grossPence: string;
  lines: BillLine[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BillDraftSummary {
  id: string;
  matterId: string;
  matterReference: string;
  matterTitle: string;
  clientName: string;
  taxPoint: string;
  dueOn: string;
  grossPence: string;
  updatedAt: Date;
}

export interface IssuedBill {
  id: string;
  draftId: string;
  reference: string;
  matterId: string;
  matterReference: string;
  clientReference: string;
  clientName: string;
  clientAddress: Omit<SupplierSnapshot, 'name' | 'vatRegistrationNumber'>;
  supplier: SupplierSnapshot;
  taxPoint: string;
  dueOn: string;
  netPence: string;
  vatPence: string;
  grossPence: string;
  issuedOn: string;
  issuedAt: Date;
  lines: BillLine[];
}

export interface IssuedBillSummary {
  id: string;
  reference: string;
  matterId: string;
  taxPoint: string;
  dueOn: string;
  netPence: string;
  vatPence: string;
  grossPence: string;
  issuedOn: string;
  issuedAt: Date;
}

export interface CreditNoteLine {
  id: string;
  position: number;
  billLineId: string;
  description: string;
  netPence: string;
  vatPence: string;
  grossPence: string;
}

export interface CreditNote {
  id: string;
  reference: string;
  billId: string;
  billReference: string;
  matterId: string;
  reason: string;
  netPence: string;
  vatPence: string;
  grossPence: string;
  issuedOn: string;
  issuedAt: Date;
  lines: CreditNoteLine[];
}

export type BankAccountKind = 'client' | 'business';
export type MoneySide = 'client' | 'business';
export type FinanceTransactionKind =
  | 'bill'
  | 'credit_note'
  | 'client_receipt'
  | 'business_receipt'
  | 'client_allocation'
  | 'business_allocation'
  | 'client_payment'
  | 'costs_transfer';

export interface BankAccount {
  id: string;
  kind: BankAccountKind;
  name: string;
  lastFour: string;
  openedOn: string;
  closedOn: string | null;
  createdAt: Date;
}

export interface FinanceTransaction {
  id: string;
  kind: FinanceTransactionKind;
  side: MoneySide;
  clientId: string;
  matterId: string;
  relatedMatterId: string | null;
  bankAccountId: string | null;
  relatedBankAccountId: string | null;
  sourcePaymentRequestId: string | null;
  reference: string | null;
  purpose: string;
  amountPence: string;
  occurredOn: string;
  postedAt: Date;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  kind: FinanceTransactionKind;
  side: MoneySide;
  direction: 'debit' | 'credit';
  amountPence: string;
  matterId: string;
  relatedMatterId: string | null;
  bankAccountId: string | null;
  relatedBankAccountId: string | null;
  reference: string | null;
  purpose: string;
  occurredOn: string;
  postedAt: Date;
}

export interface MatterLedger {
  matterId: string;
  clientBalancePence: string;
  businessBalancePence: string;
  entries: LedgerEntry[];
}

export interface CashBook {
  bankAccount: BankAccount;
  balancePence: string;
  entries: LedgerEntry[];
}
