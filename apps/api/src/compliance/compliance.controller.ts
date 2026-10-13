import { pipeline } from 'node:stream/promises';
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpException, HttpStatus, Logger,
  NotFoundException, Param, Post, Query, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { attachmentDisposition } from '../documents/content-disposition.js';
import { discardUpload, readUpload, UploadFormError } from '../documents/upload-request.js';
import type {
  AssessmentWork, CddCase, Clearance, Gate, Hold, StartException, ControlVersion, CountryListVersion, IndependentReview, OfficerAppointment, PolicyAcknowledgement, RiskAssessment, StaffPolicy, TrainingCompletion,
} from './compliance.js';
import { ComplianceService, type Change, type ComplianceActor } from './compliance.service.js';

const date = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31', 'Date is outside the supported range');
const pageQuery = z.strictObject({ before: z.uuid().optional() });
const person = z.object({ accountId: z.uuid(), displayName: z.string() });
const officerKind = z.enum(['nominated_officer', 'deputy']);
const controlKind = z.enum(['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
  'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy', 'conflicts_policy', 'client_care_policy',
  'complaints_policy', 'confidentiality_policy', 'data_protection_policy', 'retention_policy',
  'information_security_policy', 'finance_policy', 'training_material']);
const acknowledgementPolicyKinds = new Set(['aml_policy', 'sanctions_policy', 'conflicts_policy',
  'client_care_policy', 'complaints_policy', 'confidentiality_policy', 'data_protection_policy',
  'retention_policy', 'information_security_policy', 'finance_policy']);
const documentText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => /[\p{L}\p{N}]/u.test(value), 'Must contain a letter or a digit')
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value), 'Contains unsafe control characters')
  .refine((value) => !/[\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(value), 'Contains unsafe text-direction characters');

const appointment = z.object({ id: z.uuid(), account: person, kind: officerKind, appointedBy: person,
  appointedAt: z.iso.datetime(), endedBy: person.nullable(), endedAt: z.iso.datetime().nullable(), endReason: z.string().nullable() });
const appointmentList = z.object({ appointments: z.array(appointment), next: z.uuid().nullable() });
const appointmentBody = z.strictObject({ accountId: z.uuid(), kind: officerKind });
const endBody = z.strictObject({ reason: text(500) });

const approval = z.object({ id: z.uuid(), approvedBy: person, approvedAt: z.iso.datetime() });
const control = z.object({ id: z.uuid(), kind: controlKind, version: z.number().int().positive(), title: z.string(),
  content: z.string(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/), source: z.string(), effectiveFrom: date,
  reviewDueOn: date, owner: person, requiresAcknowledgement: z.boolean(),
  acknowledgementDueDays: z.number().int().min(1).max(365).nullable(),
  preparedBy: person, preparedAt: z.iso.datetime(), approval: approval.nullable() });
const controlList = z.object({ controls: z.array(control), next: z.uuid().nullable() });
const controlBody = z.strictObject({ kind: controlKind, title: text(200), content: documentText(200_000),
  source: text(2_000), effectiveFrom: date, reviewDueOn: date, ownerAccountId: z.uuid().optional(),
  requiresAcknowledgement: z.boolean().default(false),
  acknowledgementDueDays: z.number().int().min(1).max(365).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.requiresAcknowledgement && !acknowledgementPolicyKinds.has(value.kind)) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Only a policy can require acknowledgement' });
  }
  if (value.requiresAcknowledgement && value.acknowledgementDueDays == null) {
    ctx.addIssue({ code: 'custom', path: ['acknowledgementDueDays'], message: 'Set the acknowledgement deadline' });
  }
  if (!value.requiresAcknowledgement && value.acknowledgementDueDays != null) {
    ctx.addIssue({ code: 'custom', path: ['acknowledgementDueDays'], message: 'A deadline requires acknowledgement' });
  }
});

const policyAcknowledgement = z.object({ id: z.uuid(), controlVersionId: z.uuid(), account: person,
  acknowledgedAt: z.iso.datetime() });
const staffPolicy = control.extend({ acknowledgement: policyAcknowledgement.nullable(),
  acknowledgementDueOn: date.nullable() });
const staffPolicyList = z.object({ policies: z.array(staffPolicy) });
const acknowledgementList = z.object({ acknowledgements: z.array(policyAcknowledgement), next: z.uuid().nullable() });

const training = z.object({ id: z.uuid(), account: person,
  material: z.object({ id: z.uuid(), version: z.number().int().positive(), title: z.string() }),
  provider: z.string(), completedOn: date, evidenceReference: z.string(), recordedBy: person, recordedAt: z.iso.datetime() });
const trainingList = z.object({ completions: z.array(training), next: z.uuid().nullable() });
const trainingBody = z.strictObject({ accountId: z.uuid().optional(), materialId: z.uuid(), provider: text(200),
  completedOn: date, evidenceReference: text(1_000) });

const review = z.object({ id: z.uuid(), periodStart: date, periodEnd: date, completedOn: date,
  reviewerName: z.string(), reviewerOrganisation: z.string().nullable(), independenceBasis: z.string(),
  scope: z.string(), findings: z.string(), recommendations: z.string(), managementResponse: z.string(),
  recordedBy: person, recordedAt: z.iso.datetime() });
const reviewList = z.object({ reviews: z.array(review), next: z.uuid().nullable() });
const reviewBody = z.strictObject({ periodStart: date, periodEnd: date, completedOn: date,
  reviewerName: text(200), reviewerOrganisation: text(200).nullable().optional(), independenceBasis: text(2_000),
  scope: documentText(10_000), findings: documentText(50_000), recommendations: documentText(50_000),
  managementResponse: documentText(50_000) });

const subjectKind = z.enum(['individual', 'legal_entity']);
const subjectRelationship = z.enum(['client', 'authorised_representative', 'director_senior_manager',
  'beneficial_owner', 'trustee', 'settlor', 'beneficiary', 'protector', 'funder', 'other_controller']);
const cddStatus = z.enum(['draft', 'submitted', 'abandoned']);
const country = z.string().regex(/^[A-Z]{2}$/);
const nullableDate = date.nullable();
const narrative = documentText(5_000).refine((value) => value.length >= 10, 'Must be at least 10 characters');

const cddBody = z.strictObject({ intendedRelationship: narrative, reason: narrative });
const abandonBody = z.strictObject({ reason: text(500, 10) });

const subjectBody = z.strictObject({
  kind: subjectKind, relationship: subjectRelationship,
  details: z.strictObject({
    name: text(300), dateOfBirth: date.optional(), nationality: text(100).optional(),
    countryOfResidence: country.optional(), legalForm: text(200).optional(), governingLaw: text(100).optional(),
    registrationNumber: text(100).optional(), registeredOffice: text(500).optional(), principalOffice: text(500).optional(),
  }),
}).superRefine((value, ctx) => {
  if (value.kind === 'individual' && !value.details.dateOfBirth) {
    ctx.addIssue({ code: 'custom', path: ['details', 'dateOfBirth'], message: 'An individual needs a date of birth' });
  }
  if (value.kind === 'legal_entity') {
    for (const field of ['legalForm', 'governingLaw', 'registeredOffice', 'principalOffice'] as const) {
      if (!value.details[field]) ctx.addIssue({ code: 'custom', path: ['details', field], message: 'A legal entity needs this detail' });
    }
  }
});

const ownershipBody = z.strictObject({
  ownedSubjectId: z.uuid(), controllerSubjectId: z.uuid(),
  ownershipPercent: z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/).nullable().optional(),
  controlKind: z.enum(['ownership', 'voting_rights', 'appointment_rights', 'significant_influence', 'other']),
  details: documentText(5_000),
});
const authorityBody = z.strictObject({
  representativeSubjectId: z.uuid(), representedSubjectId: z.uuid(), evidenceId: z.uuid(),
  authorityType: text(100), verifiedOn: date, details: documentText(5_000),
});
const reliance = z.strictObject({
  regulatedPerson: text(300), jurisdiction: text(100), eligibilityBasis: documentText(2_000),
  writtenAgreementReference: text(300), underlyingEvidenceRequested: z.boolean(),
  underlyingEvidenceReceived: z.boolean(), review: documentText(2_000),
});
const verificationBody = z.strictObject({
  subjectId: z.uuid(), evidenceId: z.uuid(), sourceType: text(100), country: country.nullable().optional(),
  checkedOn: date, expiresOn: nullableDate.optional(),
  method: z.enum(['manual', 'electronic', 'certified_copy', 'in_person', 'other']),
  outcome: z.enum(['verified', 'failed', 'inconclusive']),
  provider: text(200).nullable().optional(), service: text(200).nullable().optional(),
  documentIdentifier: text(500).nullable().optional(), providerResult: documentText(10_000).nullable().optional(),
  reliance: reliance.nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.method !== 'electronic') return;
  if (!value.provider) ctx.addIssue({ code: 'custom', path: ['provider'], message: 'Electronic verification needs the provider' });
  if (!value.service) ctx.addIssue({ code: 'custom', path: ['service'], message: 'Electronic verification needs the service' });
});
const evidenceFields = z.strictObject({
  evidenceType: text(100), country: country.nullable().optional(),
  issuedOn: nullableDate.optional(), expiresOn: nullableDate.optional(),
  documentIdentifier: text(500).nullable().optional(),
  providerPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});

const subjectSchema = z.object({ id: z.uuid(), kind: subjectKind, relationship: subjectRelationship,
  details: z.record(z.string(), z.unknown()), recordedAt: z.iso.datetime() });
const evidenceSchema = z.object({ id: z.uuid(), evidenceType: z.string(), country: country.nullable(),
  issuedOn: nullableDate, expiresOn: nullableDate, fileName: z.string(), documentIdentifier: z.string().nullable(),
  providerPayloadHash: z.string().nullable(), mediaType: z.string(), sizeBytes: z.number().int(), uploadedAt: z.iso.datetime() });
const ownershipSchema = z.object({ id: z.uuid(), ownedSubjectId: z.uuid(), controllerSubjectId: z.uuid(),
  ownershipPercent: z.string().nullable(), controlKind: z.string(), details: z.string(), recordedAt: z.iso.datetime() });
const authoritySchema = z.object({ id: z.uuid(), representativeSubjectId: z.uuid(), representedSubjectId: z.uuid(),
  evidenceId: z.uuid(), authorityType: z.string(), verifiedOn: date, details: z.string(), recordedAt: z.iso.datetime() });
const verificationSchema = z.object({ id: z.uuid(), subjectId: z.uuid(), evidenceId: z.uuid(), sourceType: z.string(),
  country: country.nullable(), checkedOn: date, expiresOn: nullableDate, method: z.string(), outcome: z.string(),
  provider: z.string().nullable(), service: z.string().nullable(), documentIdentifier: z.string().nullable(),
  providerResult: z.string().nullable(), reliance: z.record(z.string(), z.unknown()).nullable(), verifiedAt: z.iso.datetime() });
const cddSchema = z.object({
  id: z.uuid(), clientId: z.uuid(), version: z.number().int(), status: cddStatus,
  intendedRelationship: z.string(), reason: z.string(), clientSnapshot: z.record(z.string(), z.unknown()).nullable(),
  preparedBy: person, createdAt: z.iso.datetime(), submittedAt: z.iso.datetime().nullable(),
  abandonment: z.object({ by: person, at: z.iso.datetime(), reason: z.string() }).nullable(),
  controls: z.array(z.object({ id: z.uuid(), kind: controlKind, version: z.number().int() })),
  subjects: z.array(subjectSchema), evidence: z.array(evidenceSchema), ownership: z.array(ownershipSchema),
  authorities: z.array(authoritySchema), verifications: z.array(verificationSchema),
});
const cddList = z.object({
  cases: z.array(z.object({ id: z.uuid(), version: z.number().int(), status: cddStatus, preparedBy: person,
    createdAt: z.iso.datetime(), submittedAt: z.iso.datetime().nullable(),
    subjectCount: z.number().int(), evidenceCount: z.number().int() })),
  next: z.uuid().nullable(),
});

/** Sorted and duplicate-free, as PostgreSQL requires, so equal lists are identical. */
const countryCodes = (max: number) => z.array(country).min(1).max(max)
  .refine((codes) => new Set(codes).size === codes.length, 'Each country may appear once')
  .transform((codes) => [...codes].sort());

const countryListBody = z.strictObject({ countries: countryCodes(250), source: text(2_000), effectiveFrom: date });
const countryListSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), countries: z.array(country),
  source: z.string(), effectiveFrom: date, preparedBy: person, preparedAt: z.iso.datetime(),
  approval: z.object({ approvedBy: person, approvedAt: z.iso.datetime() }).nullable() });
const countryListPage = z.object({ countryLists: z.array(countryListSchema), next: z.uuid().nullable() });

const riskRating = z.enum(['low', 'standard', 'high']);
const expectedValue = z.enum(['none', 'under_10k', '10k_to_100k', '100k_to_1m', 'over_1m']);
const riskText = documentText(10_000).refine((value) => value.length >= 20, 'Give a tailored explanation of at least 20 characters');
const NARRATIVE_FIELDS = ['scopeReason', 'clientRisk', 'serviceRisk', 'purposeAndNature', 'fundingRisk',
  'sanctionsExposure', 'rationale', 'mitigations', 'requiredChecks', 'monitoringPlan'] as const;
const riskFactors = z.strictObject({ pep: z.boolean(), unusualTransactions: z.boolean(), complexStructure: z.boolean(),
  cash: z.boolean(), remoteInstruction: z.boolean(), adverseInformation: z.boolean(),
  sanctionsExposure: z.boolean(), thirdPartyFunding: z.boolean() });
const riskBody = z.strictObject({
  inScope: z.boolean(), rating: riskRating, factors: riskFactors, jurisdictions: countryCodes(50),
  expectedValue, reviewDueOn: date, reviewGraceDays: z.number().int().min(0).max(90),
  narrative: z.strictObject({
    ...Object.fromEntries(NARRATIVE_FIELDS.map((field) => [field, riskText])) as Record<typeof NARRATIVE_FIELDS[number], typeof riskText>,
    loweringGrounds: riskText.nullable().optional(),
  }),
}).superRefine((value, ctx) => {
  if ((value.factors.pep || value.factors.unusualTransactions) && value.rating !== 'high') {
    ctx.addIssue({ code: 'custom', path: ['rating'], message: 'A PEP or unusual transactions require a high rating' });
  }
  // The same words in two answers means at least one question was not really considered.
  const seen = new Map<string, string>();
  for (const field of NARRATIVE_FIELDS) {
    const normalized = value.narrative[field].toLowerCase().replace(/\s+/g, ' ');
    const earlier = seen.get(normalized);
    if (earlier) ctx.addIssue({ code: 'custom', path: ['narrative', field], message: `Repeats the answer given for ${earlier}` });
    else seen.set(normalized, field);
  }
});
const riskSchema = z.object({
  id: z.uuid(), matterId: z.uuid(), clientId: z.uuid(), version: z.number().int().positive(), inScope: z.boolean(),
  cddCaseId: z.uuid().nullable(), countryListVersionId: z.uuid(), rating: riskRating,
  factors: riskFactors.extend({ highRiskCountry: z.boolean() }), jurisdictions: z.array(country), expectedValue,
  lowersPrevious: z.boolean(), reviewDueOn: date, reviewGraceDays: z.number().int(),
  narrative: z.object({ ...Object.fromEntries(NARRATIVE_FIELDS.map((field) => [field, z.string()])), loweringGrounds: z.string().nullable() }),
  controls: z.array(z.object({ id: z.uuid(), kind: controlKind, version: z.number().int() })),
  preparedBy: person, submittedAt: z.iso.datetime(),
});
const riskPage = z.object({
  assessments: z.array(z.object({ id: z.uuid(), version: z.number().int().positive(), inScope: z.boolean(),
    rating: riskRating, reviewDueOn: date, preparedBy: person, submittedAt: z.iso.datetime() })),
  next: z.uuid().nullable(),
});

const measureKind = z.enum(['identity', 'beneficial_ownership', 'authority', 'purpose_nature', 'ongoing_monitoring',
  'additional_sources', 'ownership_background', 'transaction_reasons', 'source_of_funds', 'source_of_wealth',
  'enhanced_monitoring', 'other']);
const outcome = z.enum(['satisfied', 'not_satisfied']);
const evidenceIds = z.array(z.uuid()).max(50).refine((ids) => new Set(ids).size === ids.length, 'Each evidence file may appear once');
const pence = z.string().regex(/^[0-9]{1,15}$/, 'A whole number of pence');
const measureBody = z.strictObject({ kind: measureKind, description: riskText });
const measureResultBody = z.strictObject({ outcome, evidenceIds, reasoning: riskText });
const sourceBody = z.strictObject({
  kind: z.enum(['funds', 'wealth']), subjectId: z.uuid().nullable(), amountMinPence: pence, amountMaxPence: pence,
  outcome, evidenceIds, reasoning: riskText,
}).refine((value) => BigInt(value.amountMaxPence) >= BigInt(value.amountMinPence),
  { path: ['amountMaxPence'], message: 'The maximum cannot be below the minimum' });
const recordedBy = { recordedBy: person, recordedAt: z.iso.datetime() };
const workSchema = z.object({
  assessmentId: z.uuid(),
  measures: z.array(z.object({ id: z.uuid(), kind: measureKind, enhanced: z.boolean(), description: z.string(), ...recordedBy,
    results: z.array(z.object({ id: z.uuid(), outcome, evidenceIds: z.array(z.uuid()), reasoning: z.string(), ...recordedBy })) })),
  conclusions: z.array(z.object({ id: z.uuid(), kind: z.enum(['funds', 'wealth']), subjectId: z.uuid().nullable(),
    amountMinPence: z.string(), amountMaxPence: z.string(), outcome, evidenceIds: z.array(z.uuid()), reasoning: z.string(), ...recordedBy })),
});

const clearanceBody = z.strictObject({ decision: z.enum(['approved', 'refused']), reasoning: riskText });
const clearanceSchema = z.object({
  id: z.uuid(), matterId: z.uuid(), assessmentId: z.uuid(), decision: z.enum(['approved', 'refused']), needsSenior: z.boolean(),
  reliedMeasureResults: z.array(z.uuid()), reliedConclusions: z.array(z.uuid()), reasoning: z.string(),
  decidedBy: person, decidedAt: z.iso.datetime(),
  seniorApproval: z.object({ approvedBy: person, approvedAt: z.iso.datetime() }).nullable(),
});
const optionalClearance = z.object({ clearance: clearanceSchema.nullable() });
const gateSchema = z.object({ state: z.enum(['pending', 'cleared', 'review_due', 'held']), dueSince: date.nullable(),
  workAllowedUntil: date.nullable(), clearanceId: z.uuid().nullable() });

const holdBody = z.strictObject({ clientId: z.uuid().optional(), matterId: z.uuid().optional(), reason: riskText })
  .refine((value) => (value.clientId === undefined) !== (value.matterId === undefined), 'Name exactly one client or matter');
const liftBody = z.strictObject({ reason: riskText });
const holdSchema = z.object({ id: z.uuid(), clientId: z.uuid(), matterId: z.uuid().nullable(), reason: z.string(),
  imposedBy: person, imposedAt: z.iso.datetime(),
  lift: z.object({ reason: z.string(), liftedBy: person, liftedAt: z.iso.datetime() }).nullable() });
const holdPage = z.object({ holds: z.array(holdSchema), next: z.uuid().nullable() });
const holdQuery = z.strictObject({ before: z.uuid().optional(), all: z.enum(['true']).optional() });
const exceptionBody = z.strictObject({
  permittedActions: z.array(z.enum(['documents', 'time'])).min(1).max(2)
    .refine((actions) => new Set(actions).size === actions.length, 'Each action may appear once')
    .transform((actions) => [...actions].sort()),
  expiresOn: date, grounds: riskText,
});
const exceptionSchema = z.object({ id: z.uuid(), matterId: z.uuid(), assessmentId: z.uuid(),
  permittedActions: z.array(z.enum(['documents', 'time'])), expiresOn: date, grounds: z.string(),
  grantedBy: person, grantedAt: z.iso.datetime(), approval: z.object({ approvedBy: person, approvedAt: z.iso.datetime() }).nullable() });
const reviewQueueSchema = z.object({ matters: z.array(z.object({ matterId: z.uuid(), reference: z.string(),
  state: z.enum(['pending', 'cleared', 'review_due', 'held']), dueSince: date.nullable(), workAllowedUntil: date.nullable(),
  reviewDueOn: date.nullable() })), next: z.uuid().nullable() });

function actorFor(session: ResolvedSession, request: Request): ComplianceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
const serializeAppointment = (value: OfficerAppointment) => ({
  ...value, appointedAt: value.appointedAt.toISOString(), endedAt: value.endedAt?.toISOString() ?? null,
});
const serializeControl = (value: ControlVersion) => ({
  ...value, preparedAt: value.preparedAt.toISOString(),
  approval: value.approval ? { ...value.approval, approvedAt: value.approval.approvedAt.toISOString() } : null,
});
const serializeAcknowledgement = (value: PolicyAcknowledgement) => ({
  ...value, acknowledgedAt: value.acknowledgedAt.toISOString(),
});
const serializeStaffPolicy = (value: StaffPolicy) => ({
  ...serializeControl(value), acknowledgement: value.acknowledgement
    ? serializeAcknowledgement(value.acknowledgement) : null,
  acknowledgementDueOn: value.acknowledgementDueOn,
});
const serializeTraining = (value: TrainingCompletion) => ({
  ...value, recordedAt: value.recordedAt.toISOString(),
});
const serializeReview = (value: IndependentReview) => ({
  ...value, recordedAt: value.recordedAt.toISOString(),
});
const serializeCdd = (value: CddCase) => ({
  ...value, createdAt: value.createdAt.toISOString(), submittedAt: value.submittedAt?.toISOString() ?? null,
  abandonment: value.abandonment ? { ...value.abandonment, at: value.abandonment.at.toISOString() } : null,
  subjects: value.subjects.map((item) => ({ ...item, recordedAt: item.recordedAt.toISOString() })),
  evidence: value.evidence.map((item) => ({ ...item, uploadedAt: item.uploadedAt.toISOString() })),
  ownership: value.ownership.map((item) => ({ ...item, recordedAt: item.recordedAt.toISOString() })),
  authorities: value.authorities.map((item) => ({ ...item, recordedAt: item.recordedAt.toISOString() })),
  verifications: value.verifications.map((item) => ({ ...item, verifiedAt: item.verifiedAt.toISOString() })),
});
const summarizeCdd = (value: CddCase) => ({
  id: value.id, version: value.version, status: value.status, preparedBy: value.preparedBy,
  createdAt: value.createdAt.toISOString(), submittedAt: value.submittedAt?.toISOString() ?? null,
  subjectCount: value.subjects.length, evidenceCount: value.evidence.length,
});

const serializeCountryList = (value: CountryListVersion) => ({
  ...value, preparedAt: value.preparedAt.toISOString(),
  approval: value.approval ? { ...value.approval, approvedAt: value.approval.approvedAt.toISOString() } : null,
});
const serializeRisk = (value: RiskAssessment) => ({ ...value, submittedAt: value.submittedAt.toISOString() });
const summarizeRisk = (value: RiskAssessment) => ({
  id: value.id, version: value.version, inScope: value.inScope, rating: value.rating,
  reviewDueOn: value.reviewDueOn, preparedBy: value.preparedBy, submittedAt: value.submittedAt.toISOString(),
});

const serializeWork = (value: AssessmentWork) => ({
  assessmentId: value.assessmentId,
  measures: value.measures.map((m) => ({ ...m, recordedAt: m.recordedAt.toISOString(),
    results: m.results.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() })) })),
  conclusions: value.conclusions.map((c) => ({ ...c, recordedAt: c.recordedAt.toISOString() })),
});

const serializeClearance = (value: Clearance) => ({
  ...value, decidedAt: value.decidedAt.toISOString(),
  seniorApproval: value.seniorApproval ? { ...value.seniorApproval, approvedAt: value.seniorApproval.approvedAt.toISOString() } : null,
});

function changedClearance(result: Change<Clearance>) {
  if (result.outcome === 'not_found') throw new NotFoundException('No risk assessment or clearance with this id');
  if (result.outcome === 'conflict') throw new ConflictException('The clearance or approval is refused; complete or reassess the work first');
  return serializeClearance(result.value);
}

const serializeHold = (value: Hold) => ({
  ...value, imposedAt: value.imposedAt.toISOString(),
  lift: value.lift ? { ...value.lift, liftedAt: value.lift.liftedAt.toISOString() } : null,
});
const serializeException = (value: StartException) => ({
  ...value, grantedAt: value.grantedAt.toISOString(),
  approval: value.approval ? { ...value.approval, approvedAt: value.approval.approvedAt.toISOString() } : null,
});

function changedWork(result: Change<AssessmentWork>) {
  if (result.outcome === 'not_found') throw new NotFoundException('No risk assessment with this id');
  if (result.outcome === 'conflict') throw new ConflictException('Only the current assessment of an open matter can change, with its own CDD evidence');
  return serializeWork(result.value);
}

function changedCdd(result: Change<CddCase>) {
  if (result.outcome === 'not_found') throw new NotFoundException('No CDD draft with this id');
  if (result.outcome === 'conflict') throw new ConflictException('The CDD record is invalid, incomplete, or already submitted');
  return serializeCdd(result.value);
}

/** File checks that mean "this kind of file is not accepted" rather than "this file is bad". */
const UNSUPPORTED_FILE = new Set(['type', 'macros', 'active_content']);

@Controller()
export class ComplianceController {
  private readonly logger = new Logger(ComplianceController.name);
  constructor(private readonly compliance: ComplianceService) {}

  @Get('compliance/officers') @RequirePermission('aml.officers.manage') @ResponseSchema(appointmentList)
  async officers(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listAppointments(query.before);
    return { appointments: page.items.map(serializeAppointment), next: page.next };
  }

  @Post('compliance/officers') @RequirePermission('aml.officers.manage') @ResponseSchema(appointment)
  async appoint(@Body({ schema: appointmentBody }) body: z.infer<typeof appointmentBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.appoint(body.accountId, body.kind, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The appointment is not valid or already active');
    return serializeAppointment(result.value);
  }

  @Post('compliance/officers/:appointmentId/end') @RequirePermission('aml.officers.manage') @ResponseSchema(appointment)
  async end(@Param('appointmentId', { schema: z.uuid() }) id: string,
    @Body({ schema: endBody }) body: z.infer<typeof endBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.endAppointment(id, body.reason, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No officer appointment with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This appointment cannot be ended');
    return serializeAppointment(result.value);
  }

  @Get('compliance/controls') @RequirePermission('aml.firm_controls') @ResponseSchema(controlList)
  async controls(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listControls(false, query.before);
    return { controls: page.items.map(serializeControl), next: page.next };
  }

  @Get('compliance/controls/pending-approval') @RequirePermission('aml.firm_approve') @ResponseSchema(controlList)
  async pendingControls(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listControls(true, query.before);
    return { controls: page.items.map(serializeControl), next: page.next };
  }

  @Get('compliance/controls/:controlId') @RequirePermission('aml.firm_controls') @ResponseSchema(control)
  async findControl(@Param('controlId', { schema: z.uuid() }) id: string) {
    const value = await this.compliance.findControl(id);
    if (!value) throw new NotFoundException('No firm-control version with this id');
    return serializeControl(value);
  }

  @Post('compliance/controls') @RequirePermission('aml.firm_controls') @ResponseSchema(control)
  async createControl(@Body({ schema: controlBody }) body: z.infer<typeof controlBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.createControl({ ...body,
      ownerAccountId: body.ownerAccountId ?? session.account.id,
      acknowledgementDueDays: body.acknowledgementDueDays ?? null,
    }, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The firm-control version is not valid');
    return serializeControl(result.value);
  }

  @Post('compliance/controls/:controlId/approval') @RequirePermission('aml.firm_approve') @ResponseSchema(control)
  async approveControl(@Param('controlId', { schema: z.uuid() }) id: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.approveControl(id, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No firm-control version with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This version cannot be approved');
    return serializeControl(result.value);
  }

  @Get('compliance/policies/me') @StaffOnly() @ResponseSchema(staffPolicyList)
  async ownPolicies(@CurrentSession() session: ResolvedSession) {
    return { policies: (await this.compliance.listStaffPolicies(session.account.id)).map(serializeStaffPolicy) };
  }

  @Post('compliance/policies/:controlId/acknowledgement') @StaffOnly() @ResponseSchema(policyAcknowledgement)
  async acknowledgePolicy(@Param('controlId', { schema: z.uuid() }) id: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.acknowledgePolicy(id, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No policy with this id');
    if (result.outcome === 'conflict') throw new ConflictException('Only an approved policy can be acknowledged, and only once');
    return serializeAcknowledgement(result.value);
  }

  @Get('compliance/policies/:controlId/acknowledgements')
  @RequirePermission('aml.firm_controls') @ResponseSchema(acknowledgementList)
  async policyAcknowledgements(@Param('controlId', { schema: z.uuid() }) id: string,
    @Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listPolicyAcknowledgements(id, query.before);
    if (!page) throw new NotFoundException('No policy with this id');
    return { acknowledgements: page.items.map(serializeAcknowledgement), next: page.next };
  }

  @Post('compliance/training') @StaffOnly() @ResponseSchema(training)
  async recordTraining(@Body({ schema: trainingBody }) body: z.infer<typeof trainingBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.recordTraining({ ...body, accountId: body.accountId ?? session.account.id }, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No training material or staff account with this id');
    if (result.outcome === 'conflict') throw new ConflictException('Training needs approved material and may be recorded only once');
    return serializeTraining(result.value);
  }

  @Get('compliance/training/me') @StaffOnly() @ResponseSchema(trainingList)
  async ownTraining(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>, @CurrentSession() session: ResolvedSession) {
    const page = await this.compliance.listTraining(session.account.id, query.before);
    return { completions: page.items.map(serializeTraining), next: page.next };
  }

  @Get('compliance/training') @RequirePermission('aml.firm_controls') @ResponseSchema(trainingList)
  async training(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listTraining(undefined, query.before);
    return { completions: page.items.map(serializeTraining), next: page.next };
  }

  @Post('compliance/independent-reviews') @RequirePermission('aml.firm_controls') @ResponseSchema(review)
  async recordReview(@Body({ schema: reviewBody }) body: z.infer<typeof reviewBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.recordReview({ ...body, reviewerOrganisation: body.reviewerOrganisation ?? null }, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The independent-review record is not valid');
    return serializeReview(result.value);
  }

  @Get('compliance/independent-reviews') @RequirePermission('aml.firm_controls') @ResponseSchema(reviewList)
  async reviews(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listReviews(query.before);
    return { reviews: page.items.map(serializeReview), next: page.next };
  }

  @Post('clients/:clientId/cdd') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async createCdd(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: cddBody }) body: z.infer<typeof cddBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.createCdd(clientId, body, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No client with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This client already has a CDD draft');
    return serializeCdd(result.value);
  }

  @Get('clients/:clientId/cdd') @RequirePermission('aml.view_evidence') @ResponseSchema(cddList)
  async listCdd(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>, @CurrentSession() session: ResolvedSession) {
    const page = await this.compliance.listCdd(clientId, session.account.id, query.before);
    if (!page) throw new NotFoundException('No client with this id');
    return { cases: page.items.map(summarizeCdd), next: page.next };
  }

  @Get('clients/:clientId/cdd/:caseId') @RequirePermission('aml.view_evidence') @ResponseSchema(cddSchema)
  async findCdd(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string, @CurrentSession() session: ResolvedSession) {
    const value = await this.compliance.findCdd(clientId, caseId, session.account.id);
    if (!value) throw new NotFoundException('No CDD case with this id');
    return serializeCdd(value);
  }

  @Post('clients/:clientId/cdd/:caseId/subjects') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async addSubject(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: subjectBody }) body: z.infer<typeof subjectBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedCdd(await this.compliance.addSubject(clientId, caseId, body, actorFor(session, request)));
  }

  @Post('clients/:clientId/cdd/:caseId/ownership') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async addOwnership(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: ownershipBody }) body: z.infer<typeof ownershipBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const input = { ...body, ownershipPercent: body.ownershipPercent ?? null };
    return changedCdd(await this.compliance.addOwnership(clientId, caseId, input, actorFor(session, request)));
  }

  @Post('clients/:clientId/cdd/:caseId/authorities') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async addAuthority(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: authorityBody }) body: z.infer<typeof authorityBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedCdd(await this.compliance.addAuthority(clientId, caseId, body, actorFor(session, request)));
  }

  @Post('clients/:clientId/cdd/:caseId/verifications') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async addVerification(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: verificationBody }) body: z.infer<typeof verificationBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const input = {
      ...body, country: body.country ?? null, expiresOn: body.expiresOn ?? null,
      provider: body.provider ?? null, service: body.service ?? null,
      documentIdentifier: body.documentIdentifier ?? null, providerResult: body.providerResult ?? null,
      reliance: body.reliance ?? null,
    };
    return changedCdd(await this.compliance.addVerification(clientId, caseId, input, actorFor(session, request)));
  }

  @Post('clients/:clientId/cdd/:caseId/evidence') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async addEvidence(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    let upload;
    try {
      upload = await readUpload(request, ['evidenceType', 'country', 'issuedOn', 'expiresOn', 'documentIdentifier', 'providerPayloadHash']);
    } catch (error) {
      if (error instanceof UploadFormError) throw new BadRequestException(error.message);
      throw error;
    }
    const parsed = evidenceFields.safeParse(upload.fields);
    if (!parsed.success) {
      discardUpload(upload.file);
      throw new BadRequestException('Give valid evidence metadata before the file');
    }
    const fields = parsed.data;
    const result = await this.compliance.addEvidence(clientId, caseId, {
      evidenceType: fields.evidenceType, country: fields.country ?? null,
      issuedOn: fields.issuedOn ?? null, expiresOn: fields.expiresOn ?? null,
      documentIdentifier: fields.documentIdentifier ?? null, providerPayloadHash: fields.providerPayloadHash ?? null,
      fileName: upload.fileName, file: upload.file,
    }, actorFor(session, request));

    switch (result.outcome) {
      case 'added': return serializeCdd(result.value);
      case 'not_found': throw new NotFoundException('No CDD draft with this id');
      case 'conflict': throw new ConflictException('The CDD case cannot accept evidence');
    }
    switch (result.reason) {
      case 'scanner_unavailable':
        throw new ServiceUnavailableException('Evidence uploads are paused because malware scanning is unavailable');
      case 'over_allowance':
        throw new HttpException('The hourly protected-evidence upload allowance has been reached', HttpStatus.TOO_MANY_REQUESTS);
      case 'file_name':
        throw new BadRequestException('The evidence file name is not accepted');
      case 'form':
      case 'interrupted':
        throw new BadRequestException('The evidence upload was interrupted or malformed');
      case 'too_large':
        throw new HttpException(`The evidence file was refused: ${result.reason}`, HttpStatus.PAYLOAD_TOO_LARGE);
      default: {
        const status = UNSUPPORTED_FILE.has(result.reason) ? HttpStatus.UNSUPPORTED_MEDIA_TYPE : HttpStatus.UNPROCESSABLE_ENTITY;
        throw new HttpException(`The evidence file was refused: ${result.reason}`, status);
      }
    }
  }

  @Post('clients/:clientId/cdd/:caseId/submit') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async submitCdd(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedCdd(await this.compliance.submitCdd(clientId, caseId, actorFor(session, request)));
  }

  @Post('clients/:clientId/cdd/:caseId/abandon') @RequirePermission('aml.assess') @ResponseSchema(cddSchema)
  async abandonCdd(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: abandonBody }) body: z.infer<typeof abandonBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedCdd(await this.compliance.abandonCdd(clientId, caseId, body.reason, actorFor(session, request)));
  }

  @Get('clients/:clientId/cdd/:caseId/evidence/:evidenceId/content') @RequirePermission('aml.view_evidence') @ResponseSchema(STREAMED)
  async evidenceContent(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Param('evidenceId', { schema: z.uuid() }) evidenceId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response) {
    const result = await this.compliance.downloadEvidence(clientId, caseId, evidenceId, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No CDD evidence with this id');
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', result.mediaType);
    response.setHeader('Content-Length', String(result.sizeBytes));
    response.setHeader('Content-Disposition', attachmentDisposition(result.fileName));
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cache-Control', 'no-store');
    try {
      await pipeline(result.file, response);
    } catch (error) {
      this.logger.error(`CDD evidence ${evidenceId} download stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  @Get('compliance/country-lists') @RequirePermission('aml.firm_controls') @ResponseSchema(countryListPage)
  async countryLists(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listCountryLists(false, query.before);
    return { countryLists: page.items.map(serializeCountryList), next: page.next };
  }

  @Get('compliance/country-lists/pending-approval') @RequirePermission('aml.firm_approve') @ResponseSchema(countryListPage)
  async pendingCountryLists(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listCountryLists(true, query.before);
    return { countryLists: page.items.map(serializeCountryList), next: page.next };
  }

  @Post('compliance/country-lists') @RequirePermission('aml.firm_controls') @ResponseSchema(countryListSchema)
  async createCountryList(@Body({ schema: countryListBody }) body: z.infer<typeof countryListBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.createCountryList(body, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The high-risk-country list is not valid');
    return serializeCountryList(result.value);
  }

  @Post('compliance/country-lists/:listId/approval') @RequirePermission('aml.firm_approve') @ResponseSchema(countryListSchema)
  async approveCountryList(@Param('listId', { schema: z.uuid() }) id: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.approveCountryList(id, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No high-risk-country list with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This list cannot be approved');
    return serializeCountryList(result.value);
  }

  @Post('matters/:matterId/aml-risk') @RequirePermission('aml.assess') @ResponseSchema(riskSchema)
  async submitRisk(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: riskBody }) body: z.infer<typeof riskBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const input = { ...body, narrative: { ...body.narrative, loweringGrounds: body.narrative.loweringGrounds ?? null } };
    const result = await this.compliance.submitRiskAssessment(matterId, input, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No matter with this id');
    if (result.outcome === 'conflict') {
      throw new ConflictException('The assessment is inconsistent, or the matter lacks the records it relies on');
    }
    return serializeRisk(result.value);
  }

  @Get('matters/:matterId/aml-risk') @RequirePermission('aml.view_evidence') @ResponseSchema(riskPage)
  async riskAssessments(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>, @CurrentSession() session: ResolvedSession) {
    const page = await this.compliance.listRiskAssessments(matterId, session.account.id, query.before);
    if (!page) throw new NotFoundException('No matter with this id');
    return { assessments: page.items.map(summarizeRisk), next: page.next };
  }

  @Get('matters/:matterId/aml-risk/:assessmentId') @RequirePermission('aml.view_evidence') @ResponseSchema(riskSchema)
  async findRisk(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string, @CurrentSession() session: ResolvedSession) {
    const value = await this.compliance.findRiskAssessment(matterId, assessmentId, session.account.id);
    if (!value) throw new NotFoundException('No risk assessment with this id');
    return serializeRisk(value);
  }

  @Get('matters/:matterId/aml-risk/:assessmentId/clearance') @RequirePermission('aml.view_evidence') @ResponseSchema(optionalClearance)
  async clearance(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string, @CurrentSession() session: ResolvedSession) {
    const value = await this.compliance.findClearance(matterId, assessmentId, session.account.id);
    if (value === undefined) throw new NotFoundException('No risk assessment with this id');
    return { clearance: value ? serializeClearance(value) : null };
  }

  @Post('matters/:matterId/aml-risk/:assessmentId/clearance') @RequirePermission('aml.approve') @ResponseSchema(clearanceSchema)
  async decideClearance(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string,
    @Body({ schema: clearanceBody }) body: z.infer<typeof clearanceBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedClearance(await this.compliance.decideClearance(matterId, assessmentId, body, actorFor(session, request)));
  }

  @Post('matters/:matterId/aml-risk/:assessmentId/clearance/senior-approval') @RequirePermission('aml.firm_approve') @ResponseSchema(clearanceSchema)
  async approveSenior(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedClearance(await this.compliance.approveSenior(matterId, assessmentId, actorFor(session, request)));
  }

  @Get('matters/:matterId/aml-gate') @RequirePermission('aml.view_evidence') @ResponseSchema(gateSchema)
  async gate(@Param('matterId', { schema: z.uuid() }) matterId: string, @CurrentSession() session: ResolvedSession): Promise<Gate> {
    const value = await this.compliance.gate(matterId, session.account.id);
    if (!value) throw new NotFoundException('No matter with this id');
    return value;
  }

  @Get('compliance/holds') @RequirePermission('aml.approve') @ResponseSchema(holdPage)
  async holds(@Query({ schema: holdQuery }) query: z.infer<typeof holdQuery>) {
    const page = await this.compliance.listHolds(query.all !== 'true', query.before);
    return { holds: page.items.map(serializeHold), next: page.next };
  }

  @Post('compliance/holds') @RequirePermission('aml.approve') @ResponseSchema(holdSchema)
  async imposeHold(@Body({ schema: holdBody }) body: z.infer<typeof holdBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.imposeHold({ clientId: body.clientId ?? null, matterId: body.matterId ?? null },
      body.reason, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No client or matter with this id');
    if (result.outcome === 'conflict') throw new ConflictException('The hold could not be recorded');
    return serializeHold(result.value);
  }

  @Post('compliance/holds/:holdId/lift') @RequirePermission('aml.approve') @ResponseSchema(holdSchema)
  async liftHold(@Param('holdId', { schema: z.uuid() }) holdId: string, @Body({ schema: liftBody }) body: z.infer<typeof liftBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.liftHold(holdId, body.reason, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No hold with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This hold has already been lifted');
    return serializeHold(result.value);
  }

  @Get('compliance/reviews') @RequirePermission('aml.approve') @ResponseSchema(reviewQueueSchema)
  async reviewQueue(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.reviewQueue(query.before);
    return { matters: page.items, next: page.next };
  }

  @Post('matters/:matterId/aml-risk/:assessmentId/start-exceptions') @RequirePermission('aml.approve') @ResponseSchema(exceptionSchema)
  async grantStartException(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string,
    @Body({ schema: exceptionBody }) body: z.infer<typeof exceptionBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.grantStartException(matterId, assessmentId, body, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No risk assessment with this id');
    if (result.outcome === 'conflict') throw new ConflictException('An early start needs a current low-risk assessment, no hold and at most 30 days');
    return serializeException(result.value);
  }

  @Post('matters/:matterId/start-exceptions/:exceptionId/approval') @RequirePermission('aml.firm_approve') @ResponseSchema(exceptionSchema)
  async approveStartException(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('exceptionId', { schema: z.uuid() }) exceptionId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.approveStartException(matterId, exceptionId, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No early-start exception with this id');
    if (result.outcome === 'conflict') throw new ConflictException('The exception needs a different partner and must not have expired');
    return serializeException(result.value);
  }

  @Get('matters/:matterId/aml-risk/:assessmentId/work') @RequirePermission('aml.view_evidence') @ResponseSchema(workSchema)
  async assessmentWork(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string, @CurrentSession() session: ResolvedSession) {
    const value = await this.compliance.findAssessmentWork(matterId, assessmentId, session.account.id);
    if (!value) throw new NotFoundException('No risk assessment with this id');
    return serializeWork(value);
  }

  @Post('matters/:matterId/aml-risk/:assessmentId/measures') @RequirePermission('aml.assess') @ResponseSchema(workSchema)
  async addMeasure(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string,
    @Body({ schema: measureBody }) body: z.infer<typeof measureBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedWork(await this.compliance.addMeasure(matterId, assessmentId, body, actorFor(session, request)));
  }

  @Post('matters/:matterId/aml-risk/:assessmentId/measures/:measureId/results') @RequirePermission('aml.assess') @ResponseSchema(workSchema)
  async recordMeasureResult(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string,
    @Param('measureId', { schema: z.uuid() }) measureId: string,
    @Body({ schema: measureResultBody }) body: z.infer<typeof measureResultBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedWork(await this.compliance.recordMeasureResult(matterId, assessmentId, measureId, body, actorFor(session, request)));
  }

  @Post('matters/:matterId/aml-risk/:assessmentId/sources') @RequirePermission('aml.assess') @ResponseSchema(workSchema)
  async recordSourceConclusion(@Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('assessmentId', { schema: z.uuid() }) assessmentId: string,
    @Body({ schema: sourceBody }) body: z.infer<typeof sourceBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changedWork(await this.compliance.recordSourceConclusion(matterId, assessmentId, body, actorFor(session, request)));
  }
}
