export interface FinancePerson {
  accountId: string;
  displayName: string;
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
