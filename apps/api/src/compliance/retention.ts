export interface LegalHoldEvent {
  id: string;
  action: 'imposed' | 'reviewed' | 'released';
  reviewOn: string | null;
  authority: string;
  reason: string;
  recordedBy: string;
  recordedAt: Date;
}

export interface RetentionSchedule {
  id: string;
  clientId: string;
  relationshipEndedOn: string;
  retentionYears: number;
  disposeAfter: string;
  governingRule: string;
  evidence: string;
  recordedBy: string;
  recordedAt: Date;
  holds: LegalHoldEvent[];
}

export interface RetentionSummary {
  id: string;
  clientId: string;
  relationshipEndedOn: string;
  retentionYears: number;
  disposeAfter: string;
  governingRule: string;
  holdAction: LegalHoldEvent['action'] | null;
  holdReviewOn: string | null;
  recordedBy: string;
  recordedAt: Date;
}

export interface DisposalRun {
  id: string;
  scheduleId: string;
  clientId: string;
  governingRule: string;
  state: 'prepared' | 'completed';
  preparedBy: string;
  preparedAt: Date;
  completedBy: string | null;
  completedAt: Date | null;
  recordCount: number | null;
}

export interface RegulatoryExportSummary {
  id: string;
  clientId: string;
  sha256: string;
  byteSize: number;
  createdBy: string;
  createdAt: Date;
}

