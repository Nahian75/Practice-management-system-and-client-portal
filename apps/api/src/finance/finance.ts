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
