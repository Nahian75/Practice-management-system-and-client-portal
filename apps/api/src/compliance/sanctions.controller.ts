import { BadRequestException, Body, ConflictException, Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { readUpload, UploadFormError } from '../documents/upload-request.js';
import { MAX_SANCTIONS_LIST_BYTES } from './sanctions-list.js';
import type { SanctionsListVersion } from './sanctions.repository.js';
import { SanctionsScreeningService } from './sanctions-screening.service.js';
import { SanctionsService } from './sanctions.service.js';

const date = z.iso.date();
const versionSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), reportDate: date,
  source: z.enum(['download', 'upload']), designationCount: z.number().int(), nameCount: z.number().int(),
  importedAt: z.iso.datetime() });
const statusSchema = z.object({ listId: z.uuid().nullable(), version: z.number().int().nullable(), reportDate: date.nullable(),
  lastSuccessAt: z.iso.datetime().nullable(), lastFailureAt: z.iso.datetime().nullable(), fresh: z.boolean() });
const importSchema = z.object({ outcome: z.enum(['imported', 'unchanged']), list: versionSchema });
const versionPage = z.object({ lists: z.array(versionSchema), next: z.uuid().nullable() });
const pageQuery = z.strictObject({ before: z.uuid().optional() });
const sanctionsState = z.enum(['clear', 'unscreened', 'stale', 'possible_match', 'confirmed']);
const stateSchema = z.object({ state: sanctionsState });
const candidatePage = z.object({ candidates: z.array(z.object({ candidateId: z.uuid(), clientId: z.uuid(), clientReference: z.string(),
  subjectRef: z.string(), uniqueId: z.string(), matchedName: z.string(), birthAgreement: z.enum(['match', 'conflict', 'unknown']),
  screenedAt: z.iso.datetime() })), next: z.uuid().nullable() });
const resolutionBody = z.strictObject({ outcome: z.enum(['false_positive', 'confirmed']), reasoning: text(10_000, 20) });
const licenceAction = z.enum(['billing', 'documents', 'money', 'time']);
const licenceBody = z.strictObject({
  clientId: z.uuid(), authority: z.enum(['ofsi', 'otsi', 'other']), kind: z.enum(['specific', 'general']), reference: text(100),
  permittedActions: z.array(licenceAction).min(1).max(4).refine((actions) => new Set(actions).size === actions.length, 'Each action may appear once')
    .transform((actions) => [...actions].sort()),
  moneyLimitPence: z.string().regex(/^[0-9]{1,12}$/).nullable(), effectiveFrom: date, expiresOn: date, conditions: text(10_000, 20),
}).refine((value) => value.permittedActions.includes('money') === (value.moneyLimitPence !== null),
  { path: ['moneyLimitPence'], message: 'Money is licensed only with a limit, and a limit only with money' })
  .refine((value) => value.expiresOn >= value.effectiveFrom, { path: ['expiresOn'], message: 'Expires before it starts' });
const revocationBody = z.strictObject({ reason: text(10_000, 20) });
const licenceSchema = z.object({ id: z.uuid(), clientId: z.uuid(), authority: z.enum(['ofsi', 'otsi', 'other']),
  kind: z.enum(['specific', 'general']), reference: z.string(), permittedActions: z.array(licenceAction),
  moneyLimitPence: z.string().nullable(), effectiveFrom: date, expiresOn: date, conditions: z.string(), recordedBy: z.uuid(),
  recordedAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable() });
const licenceList = z.object({ licences: z.array(licenceSchema) });
const frozenList = z.object({ frozenFunds: z.array(z.object({ id: z.uuid(), clientId: z.uuid(), matterId: z.uuid(),
  amountPence: z.string(), reason: z.enum(['balance_at_confirmation', 'receipt']), financeTransactionId: z.uuid().nullable(),
  frozenAt: z.iso.datetime() })) });
const clientQuery = z.strictObject({ clientId: z.uuid() });

const serializeVersion = (value: SanctionsListVersion) => ({ ...value, importedAt: value.importedAt.toISOString() });
const okSchema = z.object({ revoked: z.literal(true) });
const serializeLicence = (value: { recordedAt: Date; revokedAt: Date | null } & Record<string, unknown>) => ({
  ...value, recordedAt: value.recordedAt.toISOString(), revokedAt: value.revokedAt?.toISOString() ?? null });

const moneyStatusSchema = z.object({ status: z.enum(['allowed', 'frozen', 'contact_compliance']),
  licence: z.object({ id: z.uuid(), limitPence: z.string(), usedPence: z.string(), expiresOn: date }).nullable() });

/**
 * What Accounts may know before moving money on a matter: allowed, frozen or contact
 * Compliance, and the limits of a licence that permits money. Never the reason.
 */
@Controller('matters')
export class MoneyStatusController {
  constructor(private readonly screening: SanctionsScreeningService) {}

  @Get(':matterId/money-status') @RequirePermission('finance.view_all') @ResponseSchema(moneyStatusSchema)
  async moneyStatus(@Param('matterId', { schema: z.uuid() }) matterId: string) {
    try {
      return await this.screening.moneyStatus(matterId);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'P0002') throw new NotFoundException('No matter with this id');
      throw error;
    }
  }
}

@Controller('compliance/sanctions')
export class SanctionsController {
  constructor(private readonly sanctions: SanctionsService, private readonly screening: SanctionsScreeningService) {}

  /** Screens a client now: its record and every subject of its latest submitted CDD case. */
  @Post('clients/:clientId/screenings') @RequirePermission('aml.sanctions') @ResponseSchema(stateSchema)
  async screen(@Param('clientId', { schema: z.uuid() }) clientId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.screening.screenClient(clientId, {
      actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) });
    if (result.outcome === 'not_found') throw new NotFoundException('No client with this id');
    if (result.outcome === 'no_list') throw new ConflictException('No sanctions list has been imported');
    return { state: result.state };
  }

  @Get('clients/:clientId') @RequirePermission('aml.sanctions') @ResponseSchema(stateSchema)
  async clientState(@Param('clientId', { schema: z.uuid() }) clientId: string) {
    return { state: await this.screening.sanctionsState(clientId) };
  }

  @Get('candidates') @RequirePermission('aml.sanctions') @ResponseSchema(candidatePage)
  async candidates(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const items = await this.screening.openCandidates(query.before);
    return { candidates: items.map((item) => ({ ...item, screenedAt: item.screenedAt.toISOString() })),
      next: items.length === 100 ? items.at(-1)!.candidateId : null };
  }

  @Post('candidates/:candidateId/resolution') @RequirePermission('aml.sanctions') @ResponseSchema(stateSchema)
  async resolve(@Param('candidateId', { schema: z.uuid() }) candidateId: string,
    @Body({ schema: resolutionBody }) body: z.infer<typeof resolutionBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.screening.resolveCandidate(candidateId, body, {
      actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) });
    if (result.outcome === 'not_found') throw new NotFoundException('No sanctions candidate with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This candidate has already been resolved');
    return { state: result.state };
  }

  @Post('licences') @RequirePermission('aml.sanctions') @ResponseSchema(licenceSchema)
  async recordLicence(@Body({ schema: licenceBody }) body: z.infer<typeof licenceBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.screening.recordLicence(body, {
      actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) });
    if (result.outcome === 'not_found') throw new NotFoundException('No client with this id');
    if (result.outcome === 'conflict') throw new ConflictException('A licence is recorded only for a confirmed designation');
    const licence = (await this.screening.licences(body.clientId)).find((item) => item.id === result.licenceId)!;
    return serializeLicence(licence);
  }

  @Post('licences/:licenceId/revocation') @RequirePermission('aml.sanctions') @ResponseSchema(okSchema)
  async revokeLicence(@Param('licenceId', { schema: z.uuid() }) licenceId: string,
    @Body({ schema: revocationBody }) body: z.infer<typeof revocationBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.screening.revokeLicence(licenceId, body.reason, {
      actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) });
    if (result.outcome === 'not_found') throw new NotFoundException('No licence with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This licence has already been revoked');
    return { revoked: true };
  }

  @Get('licences') @RequirePermission('aml.sanctions') @ResponseSchema(licenceList)
  async licences(@Query({ schema: clientQuery }) query: z.infer<typeof clientQuery>) {
    return { licences: (await this.screening.licences(query.clientId)).map(serializeLicence) };
  }

  @Get('frozen-funds') @RequirePermission('aml.sanctions') @ResponseSchema(frozenList)
  async frozenFunds(@Query({ schema: clientQuery }) query: z.infer<typeof clientQuery>) {
    return { frozenFunds: (await this.screening.frozenFunds(query.clientId)).map((item) => ({ ...item, frozenAt: item.frozenAt.toISOString() })) };
  }

  @Get('status') @RequirePermission('aml.sanctions') @ResponseSchema(statusSchema)
  async status() {
    const value = await this.sanctions.status();
    return { ...value, lastSuccessAt: value.lastSuccessAt?.toISOString() ?? null, lastFailureAt: value.lastFailureAt?.toISOString() ?? null };
  }

  @Get('lists') @RequirePermission('aml.sanctions') @ResponseSchema(versionPage)
  async lists(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.sanctions.listVersions(query.before);
    return { lists: page.items.map(serializeVersion), next: page.next };
  }

  /** A manual upload of the official CSV, for when the scheduled download is unavailable. */
  @Post('lists') @RequirePermission('aml.sanctions') @ResponseSchema(importSchema)
  async upload(@CurrentSession() session: ResolvedSession, @Req() request: Request) {
    let upload;
    try {
      upload = await readUpload(request, [], MAX_SANCTIONS_LIST_BYTES);
    } catch (error) {
      if (error instanceof UploadFormError) throw new BadRequestException(error.message);
      throw error;
    }
    const result = await this.sanctions.importList(upload.file, {
      actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request),
    });
    if (result.outcome === 'refused') {
      if (result.reason === 'too_large') throw new HttpException('The sanctions list file is too large', HttpStatus.PAYLOAD_TOO_LARGE);
      if (result.reason === 'older_report') throw new HttpException('A newer sanctions list is already active', HttpStatus.CONFLICT);
      throw new HttpException('The file is not the official UK Sanctions List CSV', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return { outcome: result.outcome, list: serializeVersion(result.list) };
  }
}
