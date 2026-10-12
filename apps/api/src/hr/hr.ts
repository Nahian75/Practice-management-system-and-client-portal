import type { HrCorrectionCategory, HrEngagementKind, HrFileCategory } from '../database/schema.js';

export interface HrContactDetails {
  personalEmail: string | null;
  phone: string | null;
  address: { line1: string; line2: string | null; town: string; postcode: string; country: string } | null;
  emergencyContact: { name: string; relationship: string; phone: string } | null;
}

export interface HrPrivateDetails {
  dateOfBirth: string | null;
}

export interface HrWorkPatternInput {
  timeZone: string;
  mondayMinutes: number;
  tuesdayMinutes: number;
  wednesdayMinutes: number;
  thursdayMinutes: number;
  fridayMinutes: number;
  saturdayMinutes: number;
  sundayMinutes: number;
}

export interface HrDirectoryMember {
  accountId: string; personId: string | null; displayName: string; workEmail: string;
  jobTitle: string | null; team: string | null; workLocation: string | null;
}

export interface HrPersonSummary extends HrDirectoryMember {
  accountStatus: 'invited' | 'active' | 'disabled';
  accessKind: 'self' | 'hr' | 'manager';
  engagementId: string | null; engagementKind: HrEngagementKind | null;
  startedOn: string | null; endedOn: string | null;
  manager: { personId: string; accountId: string; displayName: string } | null;
}

export interface HrCorrection {
  id: string; personId: string; category: HrCorrectionCategory; request: string;
  submittedBy: string; submittedAt: Date; outcome: 'resolved' | 'rejected' | null;
  response: string | null; decidedBy: string | null; decidedAt: Date | null;
}

export interface HrFileSummary {
  id: string; category: HrFileCategory; workerVisible: boolean; fileName: string;
  mediaType: string; sizeBytes: number; uploadedBy: string; uploadedAt: Date;
}
