export interface HrAccess {
  personId: string | null;
  reportCount: number;
  canManagePeople: boolean;
  canManageLeave: boolean;
  canManageHealth: boolean;
  canManageVetting: boolean;
  canManageCompetence: boolean;
  canManageCases: boolean;
  canManageRetention: boolean;
  canManageExports: boolean;
}

export function hasHrWorkspace(access: HrAccess): boolean {
  return access.canManagePeople || access.canManageLeave || access.canManageHealth || access.canManageVetting
    || access.canManageCompetence || access.canManageCases || access.canManageRetention || access.canManageExports;
}

export interface HrDirectoryMember {
  accountId: string;
  personId: string | null;
  displayName: string;
  workEmail: string;
  jobTitle: string | null;
  team: string | null;
  workLocation: string | null;
}

export interface HrPersonSummary extends HrDirectoryMember {
  personId: string;
  accountStatus: 'invited' | 'active' | 'disabled';
  accessKind: 'self' | 'hr' | 'manager';
  engagementId: string | null;
  engagementKind: string | null;
  startedOn: string | null;
  endedOn: string | null;
  manager: { personId: string; accountId: string; displayName: string } | null;
}

export interface HrPersonRecord extends HrPersonSummary {
  contact: { personalEmail: string | null; phone: string | null; address: {
    line1: string; line2?: string | null; town: string; postcode: string; country: string;
  } | null; emergencyContact: { name: string; relationship: string; phone: string } | null };
  privateDetails: { dateOfBirth: string | null };
  engagements: Array<{ id: string; kind: string; startedOn: string; endedOn: string | null }>;
  terms: Array<{ id: string; engagementId: string; effectiveOn: string; jobTitle: string;
    team: string | null; workLocation: string | null }>;
  managerEvents: Array<{ id: string; action: 'assigned' | 'cleared'; managerPersonId: string | null; effectiveOn: string }>;
  workPatterns: HrWorkPattern[];
  corrections: HrCorrection[];
  files: Array<{ id: string; category: string; workerVisible: boolean; fileName: string;
    mediaType: string; sizeBytes: number; uploadedAt: string }>;
}

export interface HrWorkPattern {
  id: string; engagementId: string; effectiveOn: string; timeZone: string;
  mondayMinutes: number; tuesdayMinutes: number; wednesdayMinutes: number;
  thursdayMinutes: number; fridayMinutes: number; saturdayMinutes: number; sundayMinutes: number;
}

export interface HrCorrection {
  id: string; personId: string; category: string; request: string; submittedAt: string;
  outcome: 'resolved' | 'rejected' | null; response: string | null; decidedAt: string | null;
}

export interface HrLeaveRequest {
  id: string; personId: string; kind: string; startsOn: string; endsOn: string; reason: string;
  state: 'pending' | 'approved' | 'refused' | 'cancelled'; decisionReason: string | null;
  approvedMinutes: number; submittedAt: string;
}

export interface HrLeaveRecord {
  requests: HrLeaveRequest[];
  balanceMinutes: number;
  entitlement: Array<{ id: string; leaveYearStart: string; kind: string; minutes: number; reason: string; recordedAt: string }>;
  holidayPay: Array<{ id: string; leaveRequestId: string; periodStartsOn: string; periodEndsOn: string;
    amountPence: number; basis: string; retentionUntil: string }>;
  sickness: Array<{ id: string; startedOn: string; endedOn: string | null; notifiedAt: string;
    fitnessStatus: string }>;
}

export interface HrHealthRecord {
  records: Array<{ id: string; kind: string; validFrom: string | null; validTo: string | null;
    details: unknown; recordedAt: string }>;
}

export interface HrAdjustments {
  adjustments: Array<{ requestId: string; personId: string; request: string | null; submittedAt: string;
    decisionId: string | null; outcome: 'agreed' | 'refused' | null; decisionReason: string | null;
    operationalInstruction: string | null; effectiveOn: string | null; reviewOn: string | null; decidedAt: string | null }>;
  progress: Array<{ id: string; decisionId: string; action: 'implemented' | 'reviewed' | 'closed';
    note: string; recordedAt: string }>;
}

export interface HrLifecycle {
  checklists: Array<{ id: string; engagementId: string; kind: 'joiner' | 'mover' | 'leaver';
    effectiveOn: string; reasonCategory: string | null; state: string; items: Array<{
      id: string; code: string; title: string; ownerKind: string; required: boolean;
      dueOn: string | null; state: string;
    }> }>;
}

export interface HrVetting {
  rightToWork: Array<{ id: string; engagementId: string; version: number; result: string | null;
    permissionType: string | null; checkedOn: string | null; expiresOn: string | null;
    followUpOn: string | null; overdue: boolean; actionRequired: boolean }>;
  rightToWorkChecks: Array<{ id: string; engagementId: string; version: number; guidanceVersion: string;
    checkRoute: string; checkedOn: string; permissionType: string; result: string; expiresOn: string | null;
    followUpOn: string | null; evidenceFileId: string; details: { identityMatchMethod: string;
      workRestrictions: string | null; providerReference: string | null } }>;
  professional: Array<{ id: string; kind: string; title: string; issuer: string; validFrom: string | null;
    validTo: string | null; identifier: string | null; restriction: string | null;
    status: string | null; checkedOn: string | null }>;
}

export interface HrCompetence {
  development: Array<{ id: string; title: string; periodStart: string; periodEnd: string; events: Array<{
    id: string; kind: string; state: string | null; narrative: string; evidenceReference: string | null; recordedAt: string;
  }> }>;
  learning: Array<{ id: string; title: string; provider: string | null; dueOn: string; details: string; events: Array<{
    id: string; action: 'completed' | 'reopened'; completedOn: string | null; note: string;
    evidenceReference: string | null; recordedAt: string;
  }> }>;
  reviews: Array<{ id: string; kind: 'objective' | 'appraisal'; title: string; periodStart: string | null;
    periodEnd: string | null; targetOn: string | null; statement: string; workerEvents: Array<{
      id: string; action: 'acknowledged' | 'response' | 'disagreement'; note: string | null; recordedAt: string;
    }> }>;
  amlTraining: Array<{ materialId: string; title: string; version: number; completedOn: string | null;
    dueOn: string; status: 'completed' | 'due' | 'expired' }>;
}

export interface HrCaseSummary { id: string; personId: string; kind: string; dueOn: string | null; state: string; openedAt: string }
export interface HrCaseDetail {
  id: string; personId: string; kind: string; dueOn: string | null; openedAt: string;
  raisedByPersonId: string | null; policyVersion: string; issue: string; openedBy: string;
  members: Array<{ id: string; accountId: string; role: string; separationOverride: string | null;
    ending: { id: string; reason: string; endedAt: string } | null }>;
  events: Array<{ id: string; kind: string; state: string | null; occurredOn: string; supersedesEventId: string | null;
    summary: string; details: string; evidenceReference: string | null; recordedBy: string; recordedAt: string }>;
}

export interface HrRetentionRule { id: string; category: string; version: number; effectiveFrom: string;
  reviewAfterMonths: number; retainMonths: number; governingRule: string; rationale: string }
export interface HrRetentionSchedule { id: string; personId: string; ruleId: string; category: string;
  sourceId: string | null; basisOn: string; reviewOn: string; disposeAfter: string; ruleVersion?: number;
  governingRule?: string; currentHold?: { action: string; reviewOn: string | null } | null; evidence?: string;
  holds?: Array<{ id: string; action: string; reviewOn: string | null; authority: string; reason: string; recordedAt: string }> }
export interface HrDisposal { id: string; scheduleId: string; personId: string; category: string; ruleVersion: number;
  governingRule: string; state: string; preparedAt: string; completedAt: string | null; recordCount: number | null }
export interface HrExport { id: string; personId: string; purpose: string; scopes: string[]; caseIds: string[];
  sha256: string; byteSize: number; createdBy: string; createdAt: string; decision: 'approved' | 'rejected' | null;
  decidedBy: string | null; decidedAt: string | null }
