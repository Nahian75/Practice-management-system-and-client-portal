import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, HttpStatus,
  NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
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
import type { ContactVerification, EvidenceRequest, PortalEvidenceRequest } from './onboarding.js';
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
const evidenceRequest = z.object({ id: z.uuid(), clientId: z.uuid(), cddCaseId: z.uuid(), contactId: z.uuid().nullable(),
  evidenceType: z.string(), instructions: z.string(), country: z.string().nullable(), dueOn: date,
  requestedBy: z.object({ accountId: z.uuid(), displayName: z.string() }), requestedAt: z.iso.datetime(),
  submission: submission.nullable() });
const evidenceRequestList = z.object({ requests: z.array(evidenceRequest) });
const portalEvidenceRequest = z.object({ id: z.uuid(), evidenceType: z.string(), instructions: z.string(), dueOn: date,
  state: z.enum(['open','submitted']), submittedAt: z.iso.datetime().nullable() });
const portalEvidenceRequestList = z.object({ requests: z.array(portalEvidenceRequest) });

function actorFor(session: ResolvedSession, request: Request): OnboardingActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
const serialize = (value: ContactVerification) => ({ ...value,
  requestedAt: value.requestedAt.toISOString(), expiresAt: value.expiresAt.toISOString(),
  verifiedAt: value.verifiedAt?.toISOString() ?? null });
const serializeEvidenceRequest = (value: EvidenceRequest) => ({ ...value, requestedAt: value.requestedAt.toISOString(),
  submission: value.submission ? { ...value.submission, uploadedAt: value.submission.uploadedAt.toISOString() } : null });
const serializePortalRequest = (value: PortalEvidenceRequest) => ({ ...value,
  submittedAt: value.submittedAt?.toISOString() ?? null });

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
