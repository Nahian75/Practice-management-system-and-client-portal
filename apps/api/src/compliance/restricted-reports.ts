export interface RestrictedReportSummary {
  id: string; observedOn: string; submittedAt: Date; decided: boolean;
}

export interface RestrictedAttachment {
  id: string; fileName: string; mediaType: string; sizeBytes: number; uploadedAt: Date;
}

export interface RestrictedDecision {
  id: string; externalReportRequired: boolean; legalGrounds: string; decidedBy: string; decidedAt: Date;
}

export interface ExternalReportRecord {
  id: string; kind: 'sar' | 'terrorist_financing_report'; damlDatfRequested: boolean;
  reference: string; submittedAt: Date; recordedAt: Date; submittedBy: string;
  events: DamlDatfEvent[];
}

export interface DamlDatfEvent {
  id: string; outcome: 'requested' | 'granted' | 'refused' | 'withdrawn' | 'expired';
  receivedAt: Date; expiresAt: Date | null; externalReference: string;
  permittedActivity: string | null; legalBasis: string; recordedBy: string; recordedAt: Date;
}

export interface RestrictedReport {
  id: string; clientId: string; matterId: string | null; financeTransactionId: string | null;
  observedOn: string; observedFacts: string; submittedBy: string; submittedAt: Date;
  attachments: RestrictedAttachment[]; decision: RestrictedDecision | null;
  externalReport: ExternalReportRecord | null;
}

export interface RestrictedAccess {
  id: string; action: 'view' | 'download' | 'export'; attachmentId: string | null; accessedBy: string; accessedAt: Date;
}
