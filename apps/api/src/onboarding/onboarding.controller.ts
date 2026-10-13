import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus,
  NotFoundException, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { ClientOnly, Public } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { OPAQUE_TOKEN_PATTERN } from '../common/crypto/opaque-token.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { discardUpload, readUpload, UploadFormError } from '../documents/upload-request.js';
import type {
  ActivationException,
  CompanySnapshot,
  ConflictAlias,
  ConflictConnectedPerson,
  ConflictDecision,
  ContactVerification,
  ElectronicCheck,
  EvidenceRequest,
  PortalEvidenceRequest,
  EngagementDocument,
  EngagementSignature,
  EngagementTemplate,
  MatterFeeEstimate,
  OnboardingPaymentRequest,
} from './onboarding.js';
import { OnboardingService, type OnboardingActor } from './onboarding.service.js';

const requestBody = z.strictObject({ contactId: z.uuid().nullable().optional() });
const verification = z.object({ id: z.uuid(), clientId: z.uuid(), contactId: z.uuid().nullable(),
  channel: z.literal('email'), address: z.string(),
  state: z.enum(['pending', 'verified', 'expired', 'superseded', 'address_changed']),
  attemptCount: z.number().int().nonnegative(), requestedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  requestedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), verifiedAt: z.iso.datetime().nullable() });
const verificationList = z.object({ verifications: z.array(verification) });
const completeBody = z.strictObject({ token: z.string().regex(OPAQUE_TOKEN_PATTERN) });
const completeResponse = z.object({ verified: z.literal(true) });
const date = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31');
const evidenceRequestBody = z.strictObject({ contactId: z.uuid().nullable().optional(), evidenceType: text(100),
  instructions: text(2_000,10), country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(), dueOn: date });
const submission = z.object({ id: z.uuid(), evidenceId: z.uuid(), uploadedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  uploadedAt: z.iso.datetime() });
const review = z.object({ id: z.uuid(), requestId: z.uuid(), evidenceId: z.uuid(), outcome: z.enum(['accepted', 'rejected']),
  reason: z.string(), exceptionNote: z.string().nullable(), reviewedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  reviewedAt: z.iso.datetime() });
const evidenceRequest = z.object({ id: z.uuid(), clientId: z.uuid(), cddCaseId: z.uuid(), contactId: z.uuid().nullable(),
  evidenceType: z.string(), instructions: z.string(), country: z.string().nullable(), dueOn: date,
  requestedBy: z.object({ accountId: z.uuid(), displayName: z.string() }), requestedAt: z.iso.datetime(),
  submission: submission.nullable(), review: review.nullable() });
const evidenceRequestList = z.object({ requests: z.array(evidenceRequest) });

const reviewBody = z.strictObject({
  requestId: z.uuid(),
  evidenceId: z.uuid(),
  outcome: z.enum(['accepted', 'rejected']),
  reason: text(2_000, 5),
  exceptionNote: text(2_000, 5).nullable().optional(),
});
const reviewResponse = z.object({
  reviewId: z.uuid(),
  outcome: z.literal('recorded'),
});

const electronicCheckBody = z.strictObject({
  cddCaseId: z.uuid().nullable().optional(),
  provider: text(100, 1),
  service: text(100, 1),
  providerReference: text(150, 1),
  documentType: text(100, 1),
  checkDate: date,
  result: z.enum(['pass', 'refer', 'fail']),
  livenessResult: z.enum(['pass', 'refer', 'fail', 'not_checked']).nullable().optional(),
  evidenceMatch: text(1000, 1).nullable().optional(),
  exceptionNote: text(2000, 1).nullable().optional(),
  rawResponseJson: z.string().min(2).max(100_000),
});
const electronicCheck = z.object({
  id: z.uuid(), clientId: z.uuid(), cddCaseId: z.uuid().nullable(), provider: z.string(), service: z.string(),
  providerReference: z.string(), documentType: z.string(), checkDate: date, result: z.enum(['pass', 'refer', 'fail']),
  livenessResult: z.enum(['pass', 'refer', 'fail', 'not_checked']).nullable(), evidenceMatch: z.string().nullable(),
  exceptionNote: z.string().nullable(), rawResponseHash: z.string(),
  recordedBy: z.object({ accountId: z.uuid(), displayName: z.string() }), recordedAt: z.iso.datetime(),
});
const electronicCheckList = z.object({ checks: z.array(electronicCheck) });
const electronicCheckRecorded = z.object({ checkId: z.uuid(), outcome: z.literal('recorded') });

const discrepancy = z.object({
  field: z.string(),
  clientValue: z.unknown().optional(),
  companiesHouseValue: z.unknown().optional(),
  description: z.string(),
});
const companyLookupResponse = z.object({
  available: z.boolean(),
  snapshot: z.object({
    companyNumber: z.string(),
    companyName: z.string(),
    companyStatus: z.string(),
    companyType: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    incorporationDate: z.string().nullable(),
    registeredOffice: z.record(z.string(), z.unknown()),
    officers: z.array(z.unknown()),
    rawPayloadJson: z.string(),
  }).optional(),
  discrepancies: z.array(discrepancy).optional(),
  error: z.string().optional(),
});
const companyStatusResponse = z.object({ configured: z.boolean() });
const companySnapshotBody = z.strictObject({
  cddCaseId: z.uuid().nullable().optional(),
  source: z.enum(['companies_house', 'overseas_registry', 'manual_evidence']),
  companyNumber: text(50, 1),
  companyName: text(250, 1),
  companyStatus: text(50, 1),
  companyType: text(100, 1).nullable().optional(),
  jurisdiction: text(100, 1).nullable().optional(),
  incorporationDate: date.nullable().optional(),
  registeredOffice: z.record(z.string(), z.unknown()),
  officers: z.array(z.unknown()),
  discrepancies: z.array(discrepancy),
  rawPayloadJson: z.string().min(2).max(500_000),
});
const companySnapshot = z.object({
  id: z.uuid(), clientId: z.uuid(), cddCaseId: z.uuid().nullable(), source: z.enum(['companies_house', 'overseas_registry', 'manual_evidence']),
  companyNumber: z.string(), companyName: z.string(), companyStatus: z.string(), companyType: z.string().nullable(),
  jurisdiction: z.string().nullable(), incorporationDate: date.nullable(), registeredOffice: z.record(z.string(), z.unknown()),
  officers: z.array(z.unknown()), discrepancies: z.array(discrepancy), rawPayloadHash: z.string(),
  retrievedAt: z.iso.datetime(), recordedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
});
const companySnapshotList = z.object({ snapshots: z.array(companySnapshot) });
const companySnapshotRecorded = z.object({ snapshotId: z.uuid(), outcome: z.literal('recorded') });

const portalEvidenceRequest = z.object({ id: z.uuid(), evidenceType: z.string(), instructions: z.string(), dueOn: date,
  state: z.enum(['open','submitted']), submittedAt: z.iso.datetime().nullable() });
const portalEvidenceRequestList = z.object({ requests: z.array(portalEvidenceRequest) });

const conflictAliasBody = z.strictObject({
  name: text(200, 1),
  kind: z.enum(['alias', 'former_name', 'trading_name']),
  notes: text(1000).nullable().optional(),
});
const conflictAlias = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  name: z.string(),
  kind: z.enum(['alias', 'former_name', 'trading_name']),
  notes: z.string().nullable(),
  createdBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  createdAt: z.iso.datetime(),
});
const conflictAliasList = z.object({ aliases: z.array(conflictAlias) });

const conflictConnectedPersonBody = z.strictObject({
  name: text(200, 1),
  relationship: z.enum(['director', 'shareholder', 'beneficial_owner', 'connected_person', 'counterparty', 'officer', 'guarantor']),
  companyName: text(200).nullable().optional(),
  notes: text(1000).nullable().optional(),
});
const conflictConnectedPerson = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  name: z.string(),
  relationship: z.enum(['director', 'shareholder', 'beneficial_owner', 'connected_person', 'counterparty', 'officer', 'guarantor']),
  companyName: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  createdAt: z.iso.datetime(),
});
const conflictConnectedPersonList = z.object({ connectedPersons: z.array(conflictConnectedPerson) });

const conflictDecisionBody = z.strictObject({
  outcome: z.enum(['clear', 'potential', 'escalated', 'approved_with_controls', 'cannot_act']),
  rationale: text(2000, 10),
  safeguards: z.array(text(500, 1)).optional().default([]),
});
const conflictDecision = z.object({
  id: z.uuid(),
  checkId: z.uuid(),
  clientId: z.uuid(),
  outcome: z.enum(['clear', 'potential', 'escalated', 'approved_with_controls', 'cannot_act']),
  rationale: z.string(),
  safeguards: z.array(z.string()),
  decidedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  decidedAt: z.iso.datetime(),
});
const conflictDecisionList = z.object({ decisions: z.array(conflictDecision) });
const conflictDecisionRecorded = z.object({ decisionId: z.uuid(), outcome: z.literal('recorded') });

const activationRequirement = z.object({
  key: z.string(),
  title: z.string(),
  status: z.enum(['satisfied', 'pending', 'blocked', 'exception']),
  details: z.string(),
  reviewer: z.string().nullable().optional(),
  lastEventAt: z.string().nullable().optional(),
});
const activationGateResponse = z.object({
  status: z.enum(['pending', 'ready', 'activated', 'blocked']),
  canActivate: z.boolean(),
  isActivated: z.boolean(),
  activatedAt: z.string().nullable(),
  activatedBy: z.string().nullable(),
  notes: z.string().nullable(),
  requirements: z.array(activationRequirement),
});

const activationExceptionBody = z.strictObject({
  requirementKey: z.enum(['conflict_check', 'email_verification', 'id_verification', 'cdd_compliance']),
  reason: text(2000, 10),
  expiresAt: z.iso.datetime(),
});
const activationException = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  requirementKey: z.enum(['conflict_check', 'email_verification', 'id_verification', 'cdd_compliance']),
  reason: z.string(),
  expiresAt: z.iso.datetime(),
  grantedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  grantedAt: z.iso.datetime(),
});
const activationExceptionList = z.object({ exceptions: z.array(activationException) });
const activationExceptionRecorded = z.object({ exceptionId: z.uuid(), outcome: z.literal('recorded') });

const activateClientBody = z.strictObject({
  notes: text(1000).nullable().optional(),
});
const activateClientResponse = z.object({
  activationId: z.uuid(),
  outcome: z.literal('activated'),
});

const clientConflictCheckList = z.object({
  checks: z.array(
    z.object({
      id: z.uuid(),
      clientId: z.uuid(),
      names: z.array(z.string()),
      matchCount: z.number().int(),
      matches: z.unknown(),
      createdAt: z.iso.datetime(),
      requestedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
    }),
  ),
});

function actorFor(session: ResolvedSession, request: Request): OnboardingActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
const serialize = (value: ContactVerification) => ({ ...value,
  requestedAt: value.requestedAt.toISOString(), expiresAt: value.expiresAt.toISOString(),
  verifiedAt: value.verifiedAt?.toISOString() ?? null });
const serializeEvidenceRequest = (value: EvidenceRequest) => ({
  ...value,
  requestedAt: value.requestedAt.toISOString(),
  submission: value.submission ? { ...value.submission, uploadedAt: value.submission.uploadedAt.toISOString() } : null,
  review: value.review ? { ...value.review, reviewedAt: value.review.reviewedAt.toISOString() } : null,
});
const serializePortalRequest = (value: PortalEvidenceRequest) => ({ ...value,
  submittedAt: value.submittedAt?.toISOString() ?? null });
const serializeElectronicCheck = (value: ElectronicCheck) => ({
  ...value,
  recordedAt: value.recordedAt.toISOString(),
});
const serializeCompanySnapshot = (value: CompanySnapshot) => ({
  ...value,
  retrievedAt: value.retrievedAt.toISOString(),
});
const serializeConflictAlias = (v: ConflictAlias) => ({ ...v, createdAt: v.createdAt.toISOString() });
const serializeConflictConnectedPerson = (v: ConflictConnectedPerson) => ({ ...v, createdAt: v.createdAt.toISOString() });
const serializeConflictDecision = (v: ConflictDecision) => ({ ...v, decidedAt: v.decidedAt.toISOString() });
const serializeActivationException = (v: ActivationException) => ({ ...v, expiresAt: v.expiresAt.toISOString(), grantedAt: v.grantedAt.toISOString() });

const feeEstimateBody = z.strictObject({
  chargingBasis: z.enum(['fixed', 'hourly', 'contingency', 'capped', 'pro_bono']),
  estimatedFeesPence: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  estimatedDisbursementsPence: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  estimatedVatPence: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  budgetLimitPence: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).nullable().optional(),
  assumptions: text(5000, 3),
  agreedWithClient: z.boolean().optional(),
});

const feeEstimate = z.object({
  id: z.uuid(),
  matterId: z.uuid(),
  clientId: z.uuid(),
  version: z.number().int().positive(),
  chargingBasis: z.enum(['fixed', 'hourly', 'contingency', 'capped', 'pro_bono']),
  estimatedFeesPence: z.string(),
  estimatedDisbursementsPence: z.string(),
  estimatedVatPence: z.string(),
  totalEstimatePence: z.string(),
  budgetLimitPence: z.string().nullable(),
  currency: z.string(),
  assumptions: z.string(),
  status: z.enum(['active', 'superseded']),
  agreedWithClient: z.boolean(),
  createdBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  createdAt: z.iso.datetime(),
});
const feeEstimateResponse = z.object({ estimateId: z.uuid(), outcome: z.literal('created') });
const feeEstimateListResponse = z.object({ estimates: z.array(feeEstimate) });

const paymentRequestCreateBody = z.strictObject({
  matterId: z.uuid().nullable().optional(),
  engagementDocumentId: z.uuid().nullable().optional(),
  kind: z.enum(['deposit_on_account', 'initial_fixed_fee', 'consultation']),
  description: text(500, 3),
  amountPence: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]),
  dueOn: date,
  bankAccountDetails: z.record(z.string(), z.unknown()).nullable().optional(),
});

const paymentRequestCreateResponse = z.object({ requestId: z.uuid(), outcome: z.literal('created') });

const onboardingPaymentRequest = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  matterId: z.uuid().nullable(),
  engagementDocumentId: z.uuid().nullable(),
  reference: z.string(),
  kind: z.enum(['deposit_on_account', 'initial_fixed_fee', 'consultation']),
  description: z.string(),
  amountPence: z.string(),
  currency: z.string(),
  dueOn: date,
  status: z.enum(['pending', 'paid', 'waived', 'cancelled']),
  paymentMethod: z.enum(['bank_transfer', 'card', 'portal_checkout', 'cheque', 'cash']).nullable(),
  paidAt: z.iso.datetime().nullable(),
  paidReference: z.string().nullable(),
  bankAccountDetails: z.record(z.string(), z.unknown()).nullable(),
  notes: z.string().nullable(),
  requestedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  requestedAt: z.iso.datetime(),
  updatedBy: z.object({ accountId: z.uuid(), displayName: z.string() }).nullable().optional(),
  updatedAt: z.iso.datetime().nullable().optional(),
});
const onboardingPaymentRequestList = z.object({ requests: z.array(onboardingPaymentRequest) });

const paymentReceiptBody = z.strictObject({
  paymentMethod: z.enum(['bank_transfer', 'card', 'portal_checkout', 'cheque', 'cash']),
  reference: text(100, 2),
  notes: text(1000).nullable().optional(),
});
const paymentReceiptResponse = z.object({ outcome: z.literal('recorded') });

const paymentWaiveBody = z.strictObject({
  reason: text(1000, 3),
});
const paymentWaiveResponse = z.object({ outcome: z.literal('waived') });

const portalPaymentRequest = z.object({
  id: z.uuid(),
  reference: z.string(),
  kind: z.enum(['deposit_on_account', 'initial_fixed_fee', 'consultation']),
  description: z.string(),
  amountPence: z.string(),
  currency: z.string(),
  dueOn: date,
  status: z.enum(['pending', 'paid', 'waived', 'cancelled']),
  bankAccountDetails: z.record(z.string(), z.unknown()).nullable(),
  paidAt: z.iso.datetime().nullable(),
  paidReference: z.string().nullable(),
});
const portalPaymentRequestList = z.object({ requests: z.array(portalPaymentRequest) });

const serializeFeeEstimate = (v: MatterFeeEstimate) => ({
  ...v,
  createdAt: v.createdAt.toISOString(),
});

const serializePaymentRequest = (v: OnboardingPaymentRequest) => ({
  ...v,
  requestedAt: v.requestedAt.toISOString(),
  paidAt: v.paidAt ? v.paidAt.toISOString() : null,
  updatedAt: v.updatedAt ? v.updatedAt.toISOString() : null,
});

const engagementTemplate = z.object({
  id: z.uuid(),
  templateKey: z.enum(['letter_of_authority', 'client_care_letter', 'fee_agreement']),
  title: z.string(),
  version: z.number().int(),
  bodyMarkdown: z.string(),
  allowedFields: z.array(z.string()),
  isActive: z.boolean(),
  createdBy: z.object({ accountId: z.uuid(), displayName: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});
const engagementTemplateList = z.object({ templates: z.array(engagementTemplate) });
const createEngagementTemplateBody = z.strictObject({
  templateKey: z.enum(['letter_of_authority', 'client_care_letter', 'fee_agreement']),
  title: text(200, 3),
  bodyMarkdown: text(20_000, 10),
  allowedFields: z.array(text(100, 1)).min(1),
});
const createEngagementTemplateResponse = z.object({
  templateId: z.uuid(),
  outcome: z.literal('created'),
});

const engagementSignatureReview = z.object({
  id: z.uuid(),
  signatureId: z.uuid(),
  outcome: z.enum(['accepted', 'rejected']),
  reason: z.string(),
  reviewedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  reviewedAt: z.iso.datetime(),
});

const engagementSignature = z.object({
  id: z.uuid(),
  engagementDocumentId: z.uuid(),
  signerName: z.string(),
  signerEmail: z.string().nullable(),
  signerRole: z.enum(['client', 'representative', 'director', 'officer']),
  signatureMethod: z.enum(['wet_signature_upload', 'portal_drawn', 'provider_electronic']),
  documentId: z.uuid().nullable(),
  rawMetadata: z.unknown(),
  signedAt: z.iso.datetime(),
  recordedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  recordedAt: z.iso.datetime(),
  review: engagementSignatureReview.nullable().optional(),
});

const engagementDocument = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  matterId: z.uuid().nullable(),
  templateId: z.uuid(),
  templateVersion: z.number().int(),
  title: z.string(),
  documentKind: z.enum(['letter_of_authority', 'client_care_letter', 'fee_agreement']),
  state: z.enum(['draft', 'sent', 'viewed', 'signed', 'declined', 'expired', 'verified']),
  inputSnapshot: z.unknown(),
  renderedContent: z.string(),
  contentHash: z.string(),
  generatedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
  generatedAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  viewedAt: z.iso.datetime().nullable(),
  declinedAt: z.iso.datetime().nullable(),
  declineReason: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  signature: engagementSignature.nullable().optional(),
});
const engagementDocumentList = z.object({ documents: z.array(engagementDocument) });

const generateEngagementDocumentBody = z.strictObject({
  templateId: z.uuid(),
  matterId: z.uuid().nullable().optional(),
  title: text(200, 3),
  fields: z.record(z.string(), z.string()),
});
const generateEngagementDocumentResponse = z.object({
  documentId: z.uuid(),
  outcome: z.literal('generated'),
});

const sendEngagementDocumentBody = z.strictObject({
  expiresAt: z.iso.datetime().nullable().optional(),
});
const sendEngagementDocumentResponse = z.object({
  outcome: z.literal('sent'),
});

const recordSignatureBody = z.strictObject({
  signerName: text(200, 1),
  signerEmail: z.string().email().nullable().optional(),
  signerRole: z.enum(['client', 'representative', 'director', 'officer']),
  signatureMethod: z.enum(['wet_signature_upload', 'portal_drawn', 'provider_electronic']),
  documentIdRef: z.uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const recordSignatureResponse = z.object({
  signatureId: z.uuid(),
  outcome: z.literal('recorded'),
});

const declineDocumentBody = z.strictObject({
  reason: text(2000, 3),
});
const declineDocumentResponse = z.object({
  outcome: z.literal('declined'),
});

const reviewSignatureBody = z.strictObject({
  outcome: z.enum(['accepted', 'rejected']),
  reason: text(2000, 3),
});
const reviewSignatureResponse = z.object({
  reviewId: z.uuid(),
  outcome: z.literal('reviewed'),
});

const portalSignBody = z.strictObject({
  signerName: text(200, 1),
  signerEmail: z.string().email().nullable().optional(),
  signerRole: z.enum(['client', 'representative', 'director', 'officer']).default('client'),
  signatureMethod: z.enum(['wet_signature_upload', 'portal_drawn', 'provider_electronic']).default('portal_drawn'),
  documentIdRef: z.uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const serializeEngagementTemplate = (t: EngagementTemplate) => ({
  ...t,
  createdAt: t.createdAt.toISOString(),
});

const serializeEngagementSignature = (s: EngagementSignature) => ({
  ...s,
  signedAt: s.signedAt.toISOString(),
  recordedAt: s.recordedAt.toISOString(),
  review: s.review ? {
    ...s.review,
    reviewedAt: s.review.reviewedAt.toISOString(),
  } : null,
});

const serializeEngagementDocument = (d: EngagementDocument) => ({
  ...d,
  generatedAt: d.generatedAt.toISOString(),
  sentAt: d.sentAt?.toISOString() ?? null,
  viewedAt: d.viewedAt?.toISOString() ?? null,
  declinedAt: d.declinedAt?.toISOString() ?? null,
  expiresAt: d.expiresAt?.toISOString() ?? null,
  signature: d.signature ? serializeEngagementSignature(d.signature) : null,
});

@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('clients/:clientId/contact-verifications') @RequirePermission('aml.assess') @ResponseSchema(verification)
  async request(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: requestBody }) body: z.infer<typeof requestBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.onboarding.requestEmail(clientId, body.contactId ?? null, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('No client or contact with this id');
      case 'limited': throw new HttpException('Too many contact verification requests; try later', HttpStatus.TOO_MANY_REQUESTS);
      case 'conflict': throw new ConflictException('This contact cannot be verified by email');
      case 'sent': return serialize(result.verification);
    }
  }

  @Get('clients/:clientId/contact-verifications') @RequirePermission('aml.assess') @ResponseSchema(verificationList)
  async list(@Param('clientId', { schema: z.uuid() }) clientId: string, @CurrentSession() session: ResolvedSession) {
    const values = await this.onboarding.listContactVerifications(clientId, session.account.id);
    if (!values) throw new NotFoundException('No client with this id');
    return { verifications: values.map(serialize) };
  }

  @Post('clients/:clientId/cdd/:caseId/evidence-requests') @RequirePermission('aml.assess') @ResponseSchema(evidenceRequest)
  async createEvidenceRequest(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: evidenceRequestBody }) body: z.infer<typeof evidenceRequestBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const created = await this.onboarding.createEvidenceRequest({ clientId, caseId, contactId: body.contactId ?? null,
      evidenceType: body.evidenceType, instructions: body.instructions, country: body.country ?? null, dueOn: body.dueOn },
      actorFor(session, request));
    if (!created) throw new ConflictException('The request needs a current CDD draft and an eligible client contact');
    return serializeEvidenceRequest(created);
  }

  @Get('clients/:clientId/cdd/:caseId/evidence-requests') @RequirePermission('aml.assess') @ResponseSchema(evidenceRequestList)
  async evidenceRequests(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string, @CurrentSession() session: ResolvedSession) {
    const values = await this.onboarding.listEvidenceRequests(clientId,caseId,session.account.id);
    if (!values) throw new NotFoundException('No client or CDD case with this id');
    return { requests: values.map(serializeEvidenceRequest) };
  }

  @Post('clients/:clientId/cdd/:caseId/evidence-reviews') @RequirePermission('aml.assess') @ResponseSchema(reviewResponse)
  async reviewEvidence(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('caseId', { schema: z.uuid() }) caseId: string,
    @Body({ schema: reviewBody }) body: z.infer<typeof reviewBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.reviewEvidence({
      clientId, caseId, requestId: body.requestId, evidenceId: body.evidenceId,
      outcome: body.outcome, reason: body.reason, exceptionNote: body.exceptionNote ?? undefined,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Evidence submission not found');
      case 'conflict': throw new ConflictException('This evidence has already been reviewed');
      case 'recorded': return { reviewId: result.reviewId, outcome: 'recorded' as const };
    }
  }

  @Post('clients/:clientId/electronic-checks') @RequirePermission('aml.assess') @ResponseSchema(electronicCheckRecorded)
  async recordElectronicCheck(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: electronicCheckBody }) body: z.infer<typeof electronicCheckBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.recordElectronicCheck({
      clientId, cddCaseId: body.cddCaseId ?? undefined, provider: body.provider, service: body.service,
      providerReference: body.providerReference, documentType: body.documentType, checkDate: body.checkDate,
      result: body.result, livenessResult: body.livenessResult ?? undefined, evidenceMatch: body.evidenceMatch ?? undefined,
      exceptionNote: body.exceptionNote ?? undefined, rawResponseJson: body.rawResponseJson,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Client or CDD case not found');
      case 'conflict': throw new ConflictException('Unable to record electronic check');
      case 'recorded': return { checkId: result.checkId, outcome: 'recorded' as const };
    }
  }

  @Get('clients/:clientId/electronic-checks') @RequirePermission('aml.assess') @ResponseSchema(electronicCheckList)
  async electronicChecks(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    const values = await this.onboarding.listElectronicChecks(clientId, session.account.id);
    if (!values) throw new NotFoundException('No client with this id');
    return { checks: values.map(serializeElectronicCheck) };
  }

  @Get('clients/:clientId/companies-house/status') @RequirePermission('aml.assess') @ResponseSchema(companyStatusResponse)
  companiesHouseStatus() {
    return { configured: this.onboarding.isCompaniesHouseConfigured() };
  }

  @Get('clients/:clientId/companies-house/lookup') @RequirePermission('aml.assess') @ResponseSchema(companyLookupResponse)
  async lookupCompaniesHouse(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Query('companyNumber', { schema: text(50, 1) }) companyNumber: string,
  ) {
    return this.onboarding.lookupCompaniesHouse(clientId, companyNumber);
  }

  @Post('clients/:clientId/company-snapshots') @RequirePermission('aml.assess') @ResponseSchema(companySnapshotRecorded)
  async recordCompanySnapshot(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: companySnapshotBody }) body: z.infer<typeof companySnapshotBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.recordCompanySnapshot({
      clientId, cddCaseId: body.cddCaseId ?? undefined, source: body.source, companyNumber: body.companyNumber,
      companyName: body.companyName, companyStatus: body.companyStatus, companyType: body.companyType ?? undefined,
      jurisdiction: body.jurisdiction ?? undefined, incorporationDate: body.incorporationDate ?? undefined,
      registeredOffice: body.registeredOffice, officers: body.officers, discrepancies: body.discrepancies,
      rawPayloadJson: body.rawPayloadJson,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Client or CDD case not found');
      case 'conflict': throw new ConflictException('Unable to record company snapshot');
      case 'recorded': return { snapshotId: result.snapshotId, outcome: 'recorded' as const };
    }
  }

  @Get('clients/:clientId/company-snapshots') @RequirePermission('aml.assess') @ResponseSchema(companySnapshotList)
  async companySnapshots(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    const values = await this.onboarding.listCompanySnapshots(clientId, session.account.id);
    if (!values) throw new NotFoundException('No client with this id');
    return { snapshots: values.map(serializeCompanySnapshot) };
  }

  @Post('clients/:clientId/conflict-aliases') @RequirePermission('clients.edit') @ResponseSchema(conflictAlias)
  async addConflictAlias(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: conflictAliasBody }) body: z.infer<typeof conflictAliasBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.addConflictAlias(clientId, {
      name: body.name, kind: body.kind, notes: body.notes ?? null,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Client not found');
      case 'conflict': throw new ConflictException('Unable to add conflict alias');
      case 'recorded': return serializeConflictAlias(result.alias);
    }
  }

  @Get('clients/:clientId/conflict-aliases') @RequirePermission('clients.view') @ResponseSchema(conflictAliasList)
  async listConflictAliases(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const aliases = await this.onboarding.listConflictAliases(clientId);
    return { aliases: aliases.map(serializeConflictAlias) };
  }

  @Post('clients/:clientId/conflict-connected-persons') @RequirePermission('clients.edit') @ResponseSchema(conflictConnectedPerson)
  async addConflictConnectedPerson(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: conflictConnectedPersonBody }) body: z.infer<typeof conflictConnectedPersonBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.addConflictConnectedPerson(clientId, {
      name: body.name, relationship: body.relationship, companyName: body.companyName ?? null, notes: body.notes ?? null,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Client not found');
      case 'conflict': throw new ConflictException('Unable to add conflict connected person');
      case 'recorded': return serializeConflictConnectedPerson(result.person);
    }
  }

  @Get('clients/:clientId/conflict-connected-persons') @RequirePermission('clients.view') @ResponseSchema(conflictConnectedPersonList)
  async listConflictConnectedPersons(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const persons = await this.onboarding.listConflictConnectedPersons(clientId);
    return { connectedPersons: persons.map(serializeConflictConnectedPerson) };
  }

  @Post('clients/:clientId/conflict-checks/:checkId/decisions') @RequirePermission('aml.assess') @ResponseSchema(conflictDecisionRecorded)
  async recordConflictDecision(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('checkId', { schema: z.uuid() }) checkId: string,
    @Body({ schema: conflictDecisionBody }) body: z.infer<typeof conflictDecisionBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.recordConflictDecision(clientId, checkId, {
      outcome: body.outcome, rationale: body.rationale, safeguards: body.safeguards,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only partner or compliance can record restricted conflict decisions');
      case 'not_found': throw new NotFoundException('Client or conflict check not found');
      case 'conflict': throw new ConflictException('Unable to record conflict decision');
      case 'recorded': return { decisionId: result.decisionId, outcome: 'recorded' as const };
    }
  }

  @Get('clients/:clientId/conflict-checks/:checkId/decisions') @RequirePermission('aml.assess') @ResponseSchema(conflictDecisionList)
  async listConflictDecisions(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('checkId', { schema: z.uuid() }) checkId: string,
  ) {
    const decisions = await this.onboarding.listConflictDecisions(clientId, checkId);
    return { decisions: decisions.map(serializeConflictDecision) };
  }

  @Get('clients/:clientId/conflict-decisions') @RequirePermission('aml.assess') @ResponseSchema(conflictDecisionList)
  async listAllClientConflictDecisions(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const decisions = await this.onboarding.listConflictDecisions(clientId);
    return { decisions: decisions.map(serializeConflictDecision) };
  }

  @Get('clients/:clientId/conflict-checks') @RequirePermission('clients.view') @ResponseSchema(clientConflictCheckList)
  async listClientConflictChecks(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const checks = await this.onboarding.listClientConflictChecks(clientId);
    return {
      checks: checks.map((c) => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  @Get('clients/:clientId/activation-gate') @RequirePermission('clients.view') @ResponseSchema(activationGateResponse)
  async getActivationGate(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const gate = await this.onboarding.getActivationGate(clientId);
    if (!gate) throw new NotFoundException('Client not found');
    return gate;
  }

  @Post('clients/:clientId/activation-exceptions') @RequirePermission('aml.assess') @ResponseSchema(activationExceptionRecorded)
  async grantActivationException(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: activationExceptionBody }) body: z.infer<typeof activationExceptionBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.grantActivationException(clientId, {
      requirementKey: body.requirementKey, reason: body.reason, expiresAt: new Date(body.expiresAt),
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only partner or compliance can grant exceptions');
      case 'not_found': throw new NotFoundException('Client not found');
      case 'conflict': throw new ConflictException('Unable to grant exception');
      case 'recorded': return { exceptionId: result.exceptionId, outcome: 'recorded' as const };
    }
  }

  @Get('clients/:clientId/activation-exceptions') @RequirePermission('clients.view') @ResponseSchema(activationExceptionList)
  async listActivationExceptions(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const exceptions = await this.onboarding.listActivationExceptions(clientId);
    return { exceptions: exceptions.map(serializeActivationException) };
  }

  @Post('clients/:clientId/activate') @RequirePermission('aml.assess') @ResponseSchema(activateClientResponse)
  async activateClient(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: activateClientBody }) body: z.infer<typeof activateClientBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.activateClient(clientId, {
      notes: body.notes ?? null,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only partner or compliance can formally activate client');
      case 'not_found': throw new NotFoundException('Client not found');
      case 'blocked': throw new ConflictException('Client onboarding requirements are not satisfied');
      case 'activated': return { activationId: result.activationId, outcome: 'activated' as const };
    }
  }

  @Get('onboarding/engagement-templates') @RequirePermission('clients.view') @ResponseSchema(engagementTemplateList)
  async listEngagementTemplates() {
    const templates = await this.onboarding.listEngagementTemplates();
    return { templates: templates.map(serializeEngagementTemplate) };
  }

  @Post('onboarding/engagement-templates') @RequirePermission('aml.assess') @ResponseSchema(createEngagementTemplateResponse)
  async createEngagementTemplate(
    @Body({ schema: createEngagementTemplateBody }) body: z.infer<typeof createEngagementTemplateBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.createEngagementTemplate(body, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only partner or compliance can create engagement templates');
      case 'conflict': throw new ConflictException('Template with this key or version already exists or is invalid');
      case 'created': return { templateId: result.templateId, outcome: 'created' as const };
    }
  }

  @Get('clients/:clientId/engagement-documents') @RequirePermission('clients.view') @ResponseSchema(engagementDocumentList)
  async listClientEngagementDocuments(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const documents = await this.onboarding.listClientEngagementDocuments(clientId);
    return { documents: documents.map(serializeEngagementDocument) };
  }

  @Post('clients/:clientId/engagement-documents') @RequirePermission('clients.edit') @ResponseSchema(generateEngagementDocumentResponse)
  async generateEngagementDocument(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: generateEngagementDocumentBody }) body: z.infer<typeof generateEngagementDocumentBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.generateEngagementDocument({
      clientId,
      matterId: body.matterId ?? null,
      templateId: body.templateId,
      title: body.title,
      fields: body.fields,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only fee earner or partner can generate engagement documents');
      case 'not_found': throw new NotFoundException('Client or engagement template not found');
      case 'conflict': throw new ConflictException('Unable to generate engagement document');
      case 'generated': return { documentId: result.documentId, outcome: 'generated' as const };
    }
  }

  @Post('clients/:clientId/engagement-documents/:documentId/send') @RequirePermission('clients.edit') @ResponseSchema(sendEngagementDocumentResponse)
  async sendEngagementDocument(
    @Param('clientId', { schema: z.uuid() }) _clientId: string,
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Body({ schema: sendEngagementDocumentBody }) body: z.infer<typeof sendEngagementDocumentBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.sendEngagementDocument(documentId, {
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only fee earner or partner can send engagement documents');
      case 'not_found': throw new NotFoundException('Engagement document not found');
      case 'conflict': throw new ConflictException('Document cannot be sent in its current state');
      case 'sent': return { outcome: 'sent' as const };
    }
  }

  @Post('clients/:clientId/engagement-documents/:documentId/signatures') @RequirePermission('clients.edit') @ResponseSchema(recordSignatureResponse)
  async recordEngagementSignature(
    @Param('clientId', { schema: z.uuid() }) _clientId: string,
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Body({ schema: recordSignatureBody }) body: z.infer<typeof recordSignatureBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.recordEngagementSignature(documentId, {
      signerName: body.signerName,
      signerEmail: body.signerEmail ?? null,
      signerRole: body.signerRole,
      signatureMethod: body.signatureMethod,
      documentIdRef: body.documentIdRef ?? null,
      metadata: body.metadata,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Engagement document not found');
      case 'conflict': throw new ConflictException('Document is not awaiting signature');
      case 'recorded': return { signatureId: result.signatureId, outcome: 'recorded' as const };
    }
  }

  @Post('clients/:clientId/engagement-documents/:documentId/decline') @RequirePermission('clients.edit') @ResponseSchema(declineDocumentResponse)
  async declineEngagementDocument(
    @Param('clientId', { schema: z.uuid() }) _clientId: string,
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Body({ schema: declineDocumentBody }) body: z.infer<typeof declineDocumentBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.declineEngagementDocument(documentId, {
      reason: body.reason,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Engagement document not found');
      case 'conflict': throw new ConflictException('Document cannot be declined in its current state');
      case 'declined': return { outcome: 'declined' as const };
    }
  }

  @Post('clients/:clientId/engagement-signatures/:signatureId/review') @RequirePermission('aml.assess') @ResponseSchema(reviewSignatureResponse)
  async reviewEngagementSignature(
    @Param('clientId', { schema: z.uuid() }) _clientId: string,
    @Param('signatureId', { schema: z.uuid() }) signatureId: string,
    @Body({ schema: reviewSignatureBody }) body: z.infer<typeof reviewSignatureBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.reviewEngagementSignature(signatureId, {
      outcome: body.outcome,
      reason: body.reason,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only fee earner, partner or compliance can review engagement signatures');
      case 'not_found': throw new NotFoundException('Engagement signature not found');
      case 'conflict': throw new ConflictException('Unable to review engagement signature');
      case 'reviewed': return { reviewId: result.reviewId, outcome: 'reviewed' as const };
    }
  }

  @Post('matters/:matterId/fee-estimates') @RequirePermission('clients.edit') @ResponseSchema(feeEstimateResponse)
  async createMatterFeeEstimate(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: feeEstimateBody }) body: z.infer<typeof feeEstimateBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.createMatterFeeEstimate(matterId, {
      chargingBasis: body.chargingBasis,
      estimatedFeesPence: body.estimatedFeesPence,
      estimatedDisbursementsPence: body.estimatedDisbursementsPence,
      estimatedVatPence: body.estimatedVatPence,
      budgetLimitPence: body.budgetLimitPence,
      assumptions: body.assumptions,
      agreedWithClient: body.agreedWithClient,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only fee earner, partner or accounts can record fee estimates');
      case 'not_found': throw new NotFoundException('Matter not found');
      case 'conflict': throw new ConflictException('Unable to record fee estimate');
      case 'created': return { estimateId: result.estimateId, outcome: 'created' as const };
    }
  }

  @Get('matters/:matterId/fee-estimates') @RequirePermission('clients.view') @ResponseSchema(feeEstimateListResponse)
  async listMatterFeeEstimates(@Param('matterId', { schema: z.uuid() }) matterId: string) {
    const estimates = await this.onboarding.listMatterFeeEstimates(matterId);
    return { estimates: estimates.map(serializeFeeEstimate) };
  }

  @Post('clients/:clientId/payment-requests') @RequirePermission('clients.edit') @ResponseSchema(paymentRequestCreateResponse)
  async createOnboardingPaymentRequest(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: paymentRequestCreateBody }) body: z.infer<typeof paymentRequestCreateBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.createOnboardingPaymentRequest(clientId, {
      matterId: body.matterId,
      engagementDocumentId: body.engagementDocumentId,
      kind: body.kind,
      description: body.description,
      amountPence: body.amountPence,
      dueOn: body.dueOn,
      bankAccountDetails: body.bankAccountDetails,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only fee earner, partner or accounts can create payment requests');
      case 'not_found': throw new NotFoundException('Client or matter not found');
      case 'conflict': throw new ConflictException('Unable to create payment request');
      case 'created': return { requestId: result.requestId, outcome: 'created' as const };
    }
  }

  @Get('clients/:clientId/payment-requests') @RequirePermission('clients.view') @ResponseSchema(onboardingPaymentRequestList)
  async listClientPaymentRequests(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    const requests = await this.onboarding.listClientPaymentRequests(clientId);
    return { requests: requests.map(serializePaymentRequest) };
  }

  @Post('clients/:clientId/payment-requests/:requestId/receipt') @RequirePermission('clients.edit') @ResponseSchema(paymentReceiptResponse)
  async recordOnboardingPaymentReceipt(
    @Param('clientId', { schema: z.uuid() }) _clientId: string,
    @Param('requestId', { schema: z.uuid() }) requestId: string,
    @Body({ schema: paymentReceiptBody }) body: z.infer<typeof paymentReceiptBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.recordOnboardingPaymentReceipt(requestId, {
      paymentMethod: body.paymentMethod,
      reference: body.reference,
      notes: body.notes,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only fee earner, partner or accounts can record payment receipts');
      case 'not_found': throw new NotFoundException('Payment request not found');
      case 'conflict': throw new ConflictException('Payment request is not pending');
      case 'recorded': return { outcome: 'recorded' as const };
    }
  }

  @Post('clients/:clientId/payment-requests/:requestId/waive') @RequirePermission('clients.edit') @ResponseSchema(paymentWaiveResponse)
  async waiveOnboardingPaymentRequest(
    @Param('clientId', { schema: z.uuid() }) _clientId: string,
    @Param('requestId', { schema: z.uuid() }) requestId: string,
    @Body({ schema: paymentWaiveBody }) body: z.infer<typeof paymentWaiveBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request,
  ) {
    const result = await this.onboarding.waiveOnboardingPaymentRequest(requestId, {
      reason: body.reason,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'forbidden': throw new ForbiddenException('Only partner or accounts can waive payment requests');
      case 'not_found': throw new NotFoundException('Payment request not found');
      case 'conflict': throw new ConflictException('Payment request is not pending');
      case 'waived': return { outcome: 'waived' as const };
    }
  }
}

@Controller('portal/evidence-requests')
@ClientOnly()
export class PortalEvidenceController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get() @ResponseSchema(portalEvidenceRequestList)
  async list(@CurrentSession() session: ResolvedSession) {
    return { requests: (await this.onboarding.listPortalEvidenceRequests(session.account.id)).map(serializePortalRequest) };
  }

  @Post(':requestId/submission') @ResponseSchema(portalEvidenceRequest)
  async upload(@Param('requestId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession,
    @Req() request: Request) {
    let upload;
    try { upload = await readUpload(request, []); }
    catch (error) { if (error instanceof UploadFormError) throw new BadRequestException(error.message); throw error; }
    const result = await this.onboarding.uploadPortalEvidence(id, upload, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': discardUpload(upload.file); throw new NotFoundException('No evidence request with this id');
      case 'conflict': throw new ConflictException('This evidence request is no longer open');
      case 'refused': throw uploadRefusal(result.reason);
      case 'uploaded': return serializePortalRequest(result.request);
    }
  }
}

@Controller('portal/engagement-documents')
@ClientOnly()
export class PortalEngagementController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get() @ResponseSchema(engagementDocumentList)
  async list(@CurrentSession() session: ResolvedSession) {
    const documents = await this.onboarding.listPortalEngagementDocuments(session.account.id);
    return { documents: documents.map(serializeEngagementDocument) };
  }

  @Get(':documentId') @ResponseSchema(engagementDocument)
  async get(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    const document = await this.onboarding.getPortalEngagementDocument(documentId, session.account.id);
    if (!document) throw new NotFoundException('Engagement document not found');
    return serializeEngagementDocument(document);
  }

  @Post(':documentId/sign') @ResponseSchema(recordSignatureResponse)
  async sign(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Body({ schema: portalSignBody }) body: z.infer<typeof portalSignBody>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const doc = await this.onboarding.getPortalEngagementDocument(documentId, session.account.id);
    if (!doc) throw new NotFoundException('Engagement document not found');
    if (doc.state !== 'sent' && doc.state !== 'viewed') {
      throw new ConflictException('Document is not awaiting signature');
    }
    const result = await this.onboarding.recordEngagementSignature(documentId, {
      signerName: body.signerName,
      signerEmail: body.signerEmail ?? null,
      signerRole: body.signerRole,
      signatureMethod: body.signatureMethod,
      documentIdRef: body.documentIdRef ?? null,
      metadata: body.metadata,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Engagement document not found');
      case 'conflict': throw new ConflictException('Document is not awaiting signature');
      case 'recorded': return { signatureId: result.signatureId, outcome: 'recorded' as const };
    }
  }

  @Post(':documentId/decline') @ResponseSchema(declineDocumentResponse)
  async decline(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Body({ schema: declineDocumentBody }) body: z.infer<typeof declineDocumentBody>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const doc = await this.onboarding.getPortalEngagementDocument(documentId, session.account.id);
    if (!doc) throw new NotFoundException('Engagement document not found');
    if (doc.state !== 'sent' && doc.state !== 'viewed') {
      throw new ConflictException('Document cannot be declined in its current state');
    }
    const result = await this.onboarding.declineEngagementDocument(documentId, {
      reason: body.reason,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found': throw new NotFoundException('Engagement document not found');
      case 'conflict': throw new ConflictException('Document cannot be declined in its current state');
      case 'declined': return { outcome: 'declined' as const };
    }
  }
}

@Controller('portal/payment-requests')
@ClientOnly()
export class PortalPaymentController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get() @ResponseSchema(portalPaymentRequestList)
  async list(@CurrentSession() session: ResolvedSession) {
    const requests = await this.onboarding.listPortalPaymentRequests(session.account.id);
    return {
      requests: requests.map((r) => ({
        id: r.id,
        reference: r.reference,
        kind: r.kind,
        description: r.description,
        amountPence: r.amountPence,
        currency: r.currency,
        dueOn: r.dueOn,
        status: r.status,
        bankAccountDetails: r.bankAccountDetails,
        paidAt: r.paidAt ? r.paidAt.toISOString() : null,
        paidReference: r.paidReference,
      })),
    };
  }
}

@Controller('contact-verifications')
@Public()
export class PublicContactVerificationController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('complete') @HttpCode(HttpStatus.OK) @ResponseSchema(completeResponse)
  async complete(@Body({ schema: completeBody }) body: z.infer<typeof completeBody>, @Req() request: Request) {
    if (await this.onboarding.completeEmail(body.token, requestContext(request)) !== 'verified') {
      throw new NotFoundException('This verification link is invalid, expired, replaced, or already used');
    }
    return { verified: true as const };
  }
}

function uploadRefusal(reason: string): HttpException {
  if (reason === 'scanner_unavailable') return new ServiceUnavailableException('File scanning is temporarily unavailable');
  if (reason === 'too_large' || reason === 'over_allowance') return new HttpException('The upload limit was reached', HttpStatus.PAYLOAD_TOO_LARGE);
  if (reason === 'malware' || reason === 'unscannable') return new HttpException('The file was not accepted', HttpStatus.UNPROCESSABLE_ENTITY);
  if (reason === 'form' || reason === 'interrupted' || reason === 'file_name') return new BadRequestException('The upload was not accepted');
  return new HttpException('This file type or content is not accepted', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
}
