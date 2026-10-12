import { BadRequestException, ConflictException, Controller, Get, HttpException, HttpStatus,
  NotFoundException, Param, Post, Put, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { PermissionsService } from '../auth/permissions/permissions.service.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { attachmentDisposition } from '../documents/content-disposition.js';
import { discardUpload, readUpload, UploadFormError } from '../documents/upload-request.js';
import { HrService, HrUploadRefusedError, type HrActor } from './hr.service.js';

const id = z.uuid();
const date = z.iso.date();
const nullableShort = text(200).nullable().optional();
const address = z.strictObject({ line1: text(200), line2: text(200).nullable().optional(), town: text(100),
  postcode: text(20), country: z.string().regex(/^[A-Z]{2}$/) });
const contactBody = z.strictObject({ personalEmail: z.email().max(254).nullable().optional(),
  phone: text(50).nullable().optional(), address: address.nullable().optional(),
  emergencyContact: z.strictObject({ name: text(200), relationship: text(100), phone: text(50) }).nullable().optional() })
  .transform((value) => ({ personalEmail: value.personalEmail ?? null, phone: value.phone ?? null,
    address: value.address ? { ...value.address, line2: value.address.line2 ?? null } : null,
    emergencyContact: value.emergencyContact ?? null }));
const privateBody = z.strictObject({ dateOfBirth: date.nullable().optional() })
  .transform((value) => ({ dateOfBirth: value.dateOfBirth ?? null }));
const personBody = z.strictObject({ accountId: id, contact: contactBody.optional(), privateDetails: privateBody.optional() });
const timeZone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(); return true; } catch { return false; }
}, 'Give a valid IANA time zone');
const minutes = z.number().int().min(0).max(1440);
const pattern = z.strictObject({ timeZone, mondayMinutes: minutes, tuesdayMinutes: minutes,
  wednesdayMinutes: minutes, thursdayMinutes: minutes, fridayMinutes: minutes,
  saturdayMinutes: minutes, sundayMinutes: minutes }).refine((value) =>
  value.mondayMinutes + value.tuesdayMinutes + value.wednesdayMinutes + value.thursdayMinutes
    + value.fridayMinutes + value.saturdayMinutes + value.sundayMinutes > 0,
  { message: 'A work pattern must contain working time' });
const engagementBody = z.strictObject({
  kind: z.enum(['employee', 'worker', 'llp_partner', 'equity_partner', 'consultant', 'apprentice', 'trainee']),
  startedOn: date, jobTitle: text(200), team: nullableShort, workLocation: nullableShort, pattern,
}).transform((value) => ({ ...value, team: value.team ?? null, workLocation: value.workLocation ?? null }));
const termsBody = z.strictObject({ engagementId: id, effectiveOn: date, jobTitle: text(200),
  team: nullableShort, workLocation: nullableShort })
  .transform((value) => ({ ...value, team: value.team ?? null, workLocation: value.workLocation ?? null }));
const patternBody = z.strictObject({ engagementId: id, effectiveOn: date, pattern });
const managerBody = z.strictObject({ managerPersonId: id.nullable().optional(), effectiveOn: date })
  .transform((value) => ({ ...value, managerPersonId: value.managerPersonId ?? null }));
const endingBody = z.strictObject({ engagementId: id, endedOn: date, reason: text(10_000, 5) });
const correctionBody = z.strictObject({ category: z.enum(['contact', 'personal', 'employment', 'manager', 'work_pattern', 'other']),
  request: text(10_000, 5) });
const decisionBody = z.strictObject({ outcome: z.enum(['resolved', 'rejected']), response: text(10_000, 5) });

const directoryMember = z.object({ accountId: id, personId: id.nullable(), displayName: z.string(), workEmail: z.string(),
  jobTitle: z.string().nullable(), team: z.string().nullable(), workLocation: z.string().nullable() });
const directorySchema = z.object({ people: z.array(directoryMember) });
const accessSchema = z.object({ personId: id.nullable(), reportCount: z.number().int().min(0).max(500),
  canManagePeople: z.boolean(), canManageLeave: z.boolean(), canManageHealth: z.boolean(),
  canManageVetting: z.boolean(), canManageCompetence: z.boolean(), canManageCases: z.boolean(),
  canManageRetention: z.boolean(), canManageExports: z.boolean() });
const summarySchema = directoryMember.extend({ accountStatus: z.enum(['invited', 'active', 'disabled']),
  accessKind: z.enum(['self', 'hr', 'manager']), engagementId: id.nullable(),
  engagementKind: z.enum(['employee', 'worker', 'llp_partner', 'equity_partner', 'consultant', 'apprentice', 'trainee']).nullable(),
  startedOn: date.nullable(), endedOn: date.nullable(), manager: z.object({ personId: id, accountId: id,
    displayName: z.string() }).nullable() });
const workPatternSchema = z.object({ id, engagementId: id, effectiveOn: date, timeZone: z.string(),
  mondayMinutes: z.number().int(), tuesdayMinutes: z.number().int(), wednesdayMinutes: z.number().int(),
  thursdayMinutes: z.number().int(), fridayMinutes: z.number().int(), saturdayMinutes: z.number().int(),
  sundayMinutes: z.number().int(), recordedBy: id, recordedAt: z.iso.datetime() });
const reportSchema = summarySchema.extend({ workPattern: workPatternSchema.nullable().optional() });
const recordSchema = summarySchema.extend({
  contact: z.object({ personalEmail: z.string().nullable(), phone: z.string().nullable(), address: address.nullable(),
    emergencyContact: z.object({ name: z.string(), relationship: z.string(), phone: z.string() }).nullable() }),
  privateDetails: z.object({ dateOfBirth: date.nullable() }),
  engagements: z.array(z.object({ id, kind: z.enum(['employee', 'worker', 'llp_partner', 'equity_partner', 'consultant', 'apprentice', 'trainee']),
    startedOn: date, endedOn: date.nullable(), createdBy: id, createdAt: z.iso.datetime() })),
  terms: z.array(z.object({ id, engagementId: id, effectiveOn: date, jobTitle: z.string(), team: z.string().nullable(),
    workLocation: z.string().nullable(), recordedBy: id, recordedAt: z.iso.datetime() })),
  managerEvents: z.array(z.object({ id, action: z.enum(['assigned', 'cleared']), managerPersonId: id.nullable(),
    effectiveOn: date, recordedBy: id, recordedAt: z.iso.datetime() })),
  workPatterns: z.array(workPatternSchema),
  corrections: z.array(z.object({ id, personId: id, category: z.enum(['contact', 'personal', 'employment', 'manager', 'work_pattern', 'other']),
    request: z.string(), submittedBy: id, submittedAt: z.iso.datetime(), outcome: z.enum(['resolved', 'rejected']).nullable(),
    response: z.string().nullable(), decidedBy: id.nullable(), decidedAt: z.iso.datetime().nullable() })),
  files: z.array(z.object({ id, category: z.enum(['contract', 'terms', 'identity', 'personal', 'other']),
    workerVisible: z.boolean(), fileName: z.string(), mediaType: z.string(), sizeBytes: z.number().int(),
    uploadedBy: id, uploadedAt: z.iso.datetime() })),
});
const peopleSchema = z.object({ people: z.array(z.object({ personId: id, accountId: id, displayName: z.string(),
  workEmail: z.string(), accountStatus: z.enum(['invited', 'active', 'disabled']), engagementId: id.nullable(),
  engagementKind: z.enum(['employee', 'worker', 'llp_partner', 'equity_partner', 'consultant', 'apprentice', 'trainee']).nullable(),
  startedOn: date.nullable(), endedOn: date.nullable(), jobTitle: z.string().nullable(), team: z.string().nullable(),
  workLocation: z.string().nullable() })) });
const correctionsSchema = z.object({ corrections: z.array(z.object({ id, personId: id, accountId: id,
  displayName: z.string(), category: z.enum(['contact', 'personal', 'employment', 'manager', 'work_pattern', 'other']),
  request: z.string(), submittedBy: id, submittedAt: z.iso.datetime(), outcome: z.enum(['resolved', 'rejected']).nullable(),
  response: z.string().nullable(), decidedBy: id.nullable(), decidedAt: z.iso.datetime().nullable() })) });

@Controller('hr')
export class HrController {
  constructor(private readonly hr: HrService, private readonly permissions: PermissionsService) {}

  @Get('access') @RequirePermission('hr.directory') @ResponseSchema(accessSchema)
  async access(@CurrentSession() session: ResolvedSession) {
    const has = (permission: Parameters<PermissionsService['has']>[1]) =>
      this.permissions.has(session.account.id, permission);
    const [personId, reports, canManagePeople, canManageLeave, canManageHealth, canManageVetting,
      canManageCompetence, canManageCases, canManageRetention, canManageExports] = await Promise.all([
      this.hr.ownPersonId(session.account.id), this.hr.reports(session.account.id), has('hr.manage'), has('hr.leave'),
      has('hr.health'), has('hr.vetting'), has('hr.competence'), has('hr.cases'), has('hr.retention'), has('hr.export'),
    ]);
    return { personId: personId ?? null, reportCount: reports.length, canManagePeople, canManageLeave,
      canManageHealth, canManageVetting, canManageCompetence, canManageCases, canManageRetention, canManageExports };
  }

  @Get('directory') @RequirePermission('hr.directory') @ResponseSchema(directorySchema)
  async directory(@CurrentSession() session: ResolvedSession) {
    return { people: await this.hr.directory(session.account.id) };
  }

  @Get('reports') @StaffOnly() @ResponseSchema(directorySchema)
  async reports(@CurrentSession() session: ResolvedSession) {
    return { people: await this.hr.reports(session.account.id) };
  }

  @Get('me') @StaffOnly() @ResponseSchema(recordSchema)
  async me(@CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const found = await this.hr.self(actorFor(session, request));
    if (!found) throw new NotFoundException('No HR record is available for your account');
    return json(found);
  }

  @Put('me/contact') @StaffOnly() @ResponseSchema(recordSchema)
  async selfContact(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    const personId = await this.findOwnPerson(session.account.id);
    return changed(await this.hr.updateContact(personId, parse(contactBody, request.body), actorFor(session, request)));
  }

  @Post('me/corrections') @StaffOnly() @ResponseSchema(recordSchema)
  async selfCorrection(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    const personId = await this.findOwnPerson(session.account.id);
    return changed(await this.hr.requestCorrection(personId, parse(correctionBody, request.body), actorFor(session, request)));
  }

  @Get('reports/:personId') @StaffOnly() @ResponseSchema(reportSchema)
  async report(@Param('personId', { schema: id }) personId: string, @CurrentSession() session: ResolvedSession) {
    const found = await this.hr.report(personId, session.account.id);
    if (!found) throw new NotFoundException('No direct-report HR record with this id');
    return json(found);
  }

  @Get('people') @RequirePermission('hr.manage') @ResponseSchema(peopleSchema)
  async people(@CurrentSession() session: ResolvedSession) { return { people: await this.hr.listPeople(session.account.id) }; }

  @Post('people') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async createPerson(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.createPerson(parse(personBody, request.body), actorFor(session, request)));
  }

  @Get('people/:personId') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async person(@Param('personId', { schema: id }) personId: string, @CurrentSession() session: ResolvedSession,
    @Req() request: Request) {
    const found = await this.hr.record(personId, actorFor(session, request));
    if (!found) throw new NotFoundException('No HR record with this id');
    return json(found);
  }

  @Put('people/:personId/contact') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async contact(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.updateContact(personId, parse(contactBody, request.body), actorFor(session, request)));
  }

  @Put('people/:personId/private') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async privateDetails(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.updatePrivate(personId, parse(privateBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/engagements') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async engagement(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.createEngagement(personId, parse(engagementBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/terms') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async terms(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.updateTerms(personId, parse(termsBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/work-patterns') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async workPattern(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.updatePattern(personId, parse(patternBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/manager') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async manager(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.updateManager(personId, parse(managerBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/end-engagement') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async end(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.endEngagement(personId, parse(endingBody, request.body), actorFor(session, request)));
  }

  @Get('corrections') @RequirePermission('hr.manage') @ResponseSchema(correctionsSchema)
  async corrections(@CurrentSession() session: ResolvedSession) {
    return json({ corrections: await this.hr.listCorrections(session.account.id) });
  }

  @Post('people/:personId/corrections/:requestId/decision') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async correctionDecision(@Param('personId', { schema: id }) personId: string,
    @Param('requestId', { schema: id }) requestId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.hr.decideCorrection(personId, requestId, parse(decisionBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/files') @RequirePermission('hr.manage') @ResponseSchema(recordSchema)
  async upload(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    let upload;
    try { upload = await readUpload(request, ['category', 'workerVisible']); }
    catch (error) { if (error instanceof UploadFormError) throw new BadRequestException(error.message); throw error; }
    const fields = z.strictObject({ category: z.enum(['contract', 'terms', 'identity', 'personal', 'other']),
      workerVisible: z.enum(['true', 'false']).transform((value) => value === 'true') }).safeParse(upload.fields);
    if (!fields.success) { discardUpload(upload.file); throw new BadRequestException('Give a valid HR file category and visibility'); }
    try {
      return changed(await this.hr.upload(personId, { ...fields.data, fileName: upload.fileName, file: upload.file },
        actorFor(session, request)));
    } catch (error) { throw uploadError(error); }
  }

  @Get('people/:personId/files/:fileId/content') @StaffOnly() @ResponseSchema(STREAMED)
  async download(@Param('personId', { schema: id }) personId: string, @Param('fileId', { schema: id }) fileId: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response) {
    const found = await this.hr.download(personId, fileId, actorFor(session, request));
    if (!found) throw new NotFoundException('No HR file with this id');
    response.status(200).set({ 'Cache-Control': 'private, no-store', 'Content-Type': found.mediaType,
      'Content-Length': String(found.sizeBytes), 'Content-Disposition': attachmentDisposition(found.fileName),
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    found.file.once('error', () => response.destroy());
    found.file.pipe(response);
  }

  private async findOwnPerson(accountId: string): Promise<string> {
    const personId = await this.hr.ownPersonId(accountId);
    if (!personId) throw new NotFoundException('No HR record is available for your account');
    return personId;
  }
}

function actorFor(session: ResolvedSession, request: Request): HrActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Give valid HR record details');
  return result.data;
}
function changed(result: Awaited<ReturnType<HrService['updateContact']>>) {
  if (result.outcome !== 'changed') {
    if (result.outcome === 'not_found') throw new NotFoundException('The HR record is not available');
    throw new ConflictException('The HR record cannot be changed in its current state');
  }
  return json(result.value);
}
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function uploadError(error: unknown): Error {
  if (!(error instanceof HrUploadRefusedError)) return error instanceof Error ? error : new Error('HR upload failed');
  if (error.reason === 'scanner_unavailable') return new ServiceUnavailableException('HR uploads are paused because malware scanning is unavailable');
  if (error.reason === 'too_large') return new HttpException('The HR file is too large', HttpStatus.PAYLOAD_TOO_LARGE);
  const status = error.reason === 'type' ? HttpStatus.UNSUPPORTED_MEDIA_TYPE : HttpStatus.UNPROCESSABLE_ENTITY;
  return new HttpException('The HR file was refused', status);
}
