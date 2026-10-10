import type { AmlControlKind, AmlOfficerKind } from '../database/schema.js';

export interface Person { accountId: string; displayName: string }

export interface OfficerAppointment {
  id: string; account: Person; kind: AmlOfficerKind;
  appointedBy: Person; appointedAt: Date;
  endedBy: Person | null; endedAt: Date | null; endReason: string | null;
}

export interface ControlVersion {
  id: string; kind: AmlControlKind; version: number; title: string; content: string;
  contentSha256: string; source: string; effectiveFrom: string; reviewDueOn: string;
  preparedBy: Person; preparedAt: Date;
  approval: { id: string; approvedBy: Person; approvedAt: Date } | null;
}

export interface TrainingCompletion {
  id: string; account: Person; material: { id: string; version: number; title: string };
  provider: string; completedOn: string; evidenceReference: string;
  recordedBy: Person; recordedAt: Date;
}

export interface IndependentReview {
  id: string; periodStart: string; periodEnd: string; completedOn: string;
  reviewerName: string; reviewerOrganisation: string | null; independenceBasis: string;
  scope: string; findings: string; recommendations: string; managementResponse: string;
  recordedBy: Person; recordedAt: Date;
}

