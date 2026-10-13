import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, HttpStatus,
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
  CompanySnapshot,
  ContactVerification,
  ElectronicCheck,
  EvidenceRequest,
  PortalEvidenceRequest,
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
