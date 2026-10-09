export interface FinanceAccess {
  canManageBilling: boolean;
  canRecordClientMoney: boolean;
  canRequestPayment: boolean;
  canApprovePayment: boolean;
  canReconcile: boolean;
  canSignOffReconciliation: boolean;
}

export interface FinancePerson { accountId: string; displayName: string }
export interface RateAccount extends FinancePerson { roles: ('partner' | 'fee_earner')[] }
export interface StaffRate { id: string; account: FinancePerson; hourlyRate: string; effectiveFrom: string; createdBy: FinancePerson; createdAt: string }
export interface TimeEntry {
  id: string; matterId: string; workedOn: string; minutes: number; hourlyRate: string;
  worker: FinancePerson; voided: boolean; recordedAt: string;
}
export interface TimeEntryDetail extends TimeEntry {
  description: string;
  corrections: { id: string; from: { workedOn: string; minutes: number; description: string; hourlyRate: string }; to: { workedOn: string; minutes: number; description: string; hourlyRate: string } | null; reason: string; correctedBy: FinancePerson; correctedAt: string }[];
}
export interface IssuedBillSummary {
  id: string; reference: string; matterId: string; taxPoint: string; dueOn: string;
  net: string; vat: string; gross: string; issuedOn: string; issuedAt: string;
}
export interface BillDraftSummary {
  id: string; matterId: string; matterReference: string; matterTitle: string; clientName: string;
  taxPoint: string; dueOn: string; gross: string; updatedAt: string;
}
export interface BillLine {
  id: string; position: number; kind: 'fee' | 'recharge' | 'disbursement'; description: string;
  net: string; vatTreatment: 'standard' | 'reduced' | 'zero' | 'exempt' | 'outside_scope';
  timeEntryId: string | null; vat: string; gross: string;
}
export interface BillDraft {
  id: string; matterId: string; status: 'draft'; taxPoint: string; dueOn: string;
  supplier: { name: string; addressLine1: string; addressLine2: string | null; town: string; postcode: string | null; country: string; vatRegistrationNumber: string | null };
  net: string; vat: string; gross: string; lines: BillLine[]; createdAt: string; updatedAt: string;
}
export interface IssuedBill extends IssuedBillSummary {
  draftId: string; matterReference: string; clientReference: string; clientName: string;
  clientAddress: { addressLine1: string; addressLine2: string | null; town: string; postcode: string | null; country: string };
  supplier: BillDraft['supplier']; lines: BillLine[];
}
export interface CreditNote {
  id: string; reference: string; billId: string; billReference: string; matterId: string; reason: string;
  net: string; vat: string; gross: string; issuedOn: string; issuedAt: string;
  lines: { id: string; position: number; billLineId: string; description: string; net: string; vat: string; gross: string }[];
}
export interface BankAccount {
  id: string; kind: 'client' | 'business'; name: string; lastFour: string;
  openedOn: string; closedOn: string | null; createdAt: string;
}
export interface LedgerEntry {
  id: string; transactionId: string; kind: string; side: 'client' | 'business';
  direction: 'debit' | 'credit'; amount: string; matterId: string; relatedMatterId: string | null;
  bankAccountId: string | null; relatedBankAccountId: string | null; reference: string | null;
  purpose: string; occurredOn: string; postedAt: string;
}
export interface MatterLedger {
  matterId: string; clientBalance: string; businessBalance: string; entries: LedgerEntry[]; next: string | null;
}
export interface CashBook {
  bankAccount: BankAccount; balance: string; entries: LedgerEntry[]; next: string | null;
}
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid' | 'bank_rejected';
export interface PaymentEvent {
  id: string; kind: Exclude<PaymentStatus, 'pending'>; reason: string | null; bankReference: string | null;
  occurredOn: string | null; financeTransactionId: string | null; actedBy: FinancePerson; actedAt: string;
}
export interface PaymentRequest {
  id: string; kind: 'refund' | 'third_party' | 'costs_transfer'; clientId: string; matterId: string;
  clientBankAccountId: string; businessBankAccountId: string | null; billId: string | null;
  evidenceDocumentId: string; purpose: string; amount: string; requestedBy: FinancePerson;
  requestedAt: string; status: PaymentStatus; events: PaymentEvent[];
}
export interface StatementMatch {
  id: string; financeTransactionId: string; matchedBy: string; matchedAt: string;
  reversedBy: string | null; reversedAt: string | null; reversalReason: string | null;
}
export interface StatementRow {
  id: string; rowNumber: number; occurredOn: string; amount: string; reference: string;
  description: string; matches: StatementMatch[];
}
export interface StatementImport {
  id: string; bankAccountId: string; periodStart: string; periodEnd: string; openingBalance: string;
  closingBalance: string; fileName: string; rowCount: number; importedBy: string; importedAt: string; rows: StatementRow[];
}
export interface ReconciliationItem {
  id: string; kind: 'unmatched_statement' | 'unmatched_cashbook' | 'difference'; sourceKey: string;
  bankAccountId: string | null; occurredOn: string | null; amount: string; reference: string | null; explanation: string;
}
export interface Reconciliation {
  id: string; asOf: string; bankBalance: string; cashbookBalance: string; clientLedgerBalance: string;
  bankCashbookDifference: string; cashbookClientDifference: string; preparedBy: string; preparedAt: string;
  statementImportIds: string[]; items: ReconciliationItem[];
  signOff: { signedOffBy: string; signedOffAt: string } | null;
}
export interface ReconciliationStatus {
  today: string;
  bankAccounts: { bankAccountId: string; kind: 'client' | 'business'; lastStatementEnd: string | null; dueOn: string; state: 'current' | 'warning' | 'overdue' }[];
  reconciliation: { lastSignedOffAsOf: string | null; dueOn: string | null; state: 'current' | 'warning' | 'overdue' | 'not_applicable' };
}

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Pending approval', approved: 'Approved, awaiting bank outcome', rejected: 'Rejected',
  cancelled: 'Cancelled', paid: 'Paid', bank_rejected: 'Rejected by bank',
};

export const PAYMENT_KIND_LABELS = { refund: 'Client refund', third_party: 'Third-party payment', costs_transfer: 'Costs transfer' } as const;

/** Exact display of an API decimal string without converting money to floating point. */
export function pounds(amount: string): string {
  const negative = amount.startsWith('-');
  const value = negative ? amount.slice(1) : amount;
  const [whole = '0', fraction = '00'] = value.split('.');
  return `${negative ? '−' : ''}£${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}
