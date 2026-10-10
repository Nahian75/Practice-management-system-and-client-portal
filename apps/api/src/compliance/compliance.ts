import type { AmlCddStatus, AmlControlKind, AmlExpectedValue, AmlOfficerKind, AmlRiskRating, AmlSubjectKind, AmlSubjectRelationship, DocumentMediaType } from '../database/schema.js';

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

export interface CddSubjectDetails {
  name: string; dateOfBirth?: string; nationality?: string; countryOfResidence?: string;
  legalForm?: string; governingLaw?: string; registrationNumber?: string;
  registeredOffice?: string; principalOffice?: string;
}
export interface CddSubject {
  id: string; kind: AmlSubjectKind; relationship: AmlSubjectRelationship;
  details: CddSubjectDetails; recordedAt: Date;
}
export interface CddEvidence {
  id: string; evidenceType: string; country: string | null; issuedOn: string | null; expiresOn: string | null;
  fileName: string; documentIdentifier: string | null; providerPayloadHash: string | null;
  mediaType: DocumentMediaType; sizeBytes: number; uploadedAt: Date;
}
export interface CddOwnership {
  id: string; ownedSubjectId: string; controllerSubjectId: string; ownershipPercent: string | null;
  controlKind: string; details: string; recordedAt: Date;
}
export interface CddAuthority {
  id: string; representativeSubjectId: string; representedSubjectId: string; evidenceId: string;
  authorityType: string; verifiedOn: string; details: string; recordedAt: Date;
}
export interface CddVerification {
  id: string; subjectId: string; evidenceId: string; sourceType: string; country: string | null;
  checkedOn: string; expiresOn: string | null; method: string; outcome: string;
  provider: string | null; service: string | null; documentIdentifier: string | null;
  providerResult: string | null; reliance: Record<string, unknown> | null; verifiedAt: Date;
}
export interface CddCase {
  id: string; clientId: string; version: number; status: AmlCddStatus;
  intendedRelationship: string; reason: string; clientSnapshot: Record<string, unknown> | null;
  preparedBy: Person; createdAt: Date; submittedAt: Date | null;
  abandonment: { by: Person; at: Date; reason: string } | null;
  controls: { id: string; kind: AmlControlKind; version: number }[];
  subjects: CddSubject[]; evidence: CddEvidence[]; ownership: CddOwnership[];
  authorities: CddAuthority[]; verifications: CddVerification[];
}

export interface CountryListVersion {
  id: string; version: number; countries: string[]; source: string; effectiveFrom: string;
  preparedBy: Person; preparedAt: Date; approval: { approvedBy: Person; approvedAt: Date } | null;
}

/** The written reasoning of an assessment. It is encrypted before it reaches PostgreSQL. */
export interface RiskNarrative {
  scopeReason: string; clientRisk: string; serviceRisk: string; purposeAndNature: string;
  fundingRisk: string; sanctionsExposure: string; rationale: string; mitigations: string;
  requiredChecks: string; monitoringPlan: string; loweringGrounds: string | null;
}
export interface RiskFactors {
  pep: boolean; unusualTransactions: boolean; complexStructure: boolean; cash: boolean;
  remoteInstruction: boolean; adverseInformation: boolean; sanctionsExposure: boolean; thirdPartyFunding: boolean;
}
export interface RiskAssessment {
  id: string; matterId: string; clientId: string; version: number; inScope: boolean;
  cddCaseId: string | null; countryListVersionId: string; rating: AmlRiskRating;
  factors: RiskFactors & { highRiskCountry: boolean }; jurisdictions: string[]; expectedValue: AmlExpectedValue;
  lowersPrevious: boolean; reviewDueOn: string; reviewGraceDays: number;
  narrative: RiskNarrative; controls: { id: string; kind: AmlControlKind; version: number }[];
  preparedBy: Person; submittedAt: Date;
}
