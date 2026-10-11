import { BadRequestException, ConflictException, Controller, Get, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { attachmentDisposition } from '../documents/content-disposition.js';
import type { ComplianceActor } from './compliance.service.js';
import { RetentionService } from './retention.service.js';

const date = z.iso.date();
const instant = z.iso.datetime();
const accessSchema = z.object({ canRestricted: z.boolean(), attentionCount: z.number().int().min(0).max(999) });
const clientChoicesSchema = z.object({ clients: z.array(z.object({ id: z.uuid(), reference: z.string(),
  kind: z.enum(['individual','organisation']), name: z.string() })) });
const holdSummary = z.object({ action: z.enum(['imposed','reviewed','released']).nullable(), reviewOn: date.nullable() });
const scheduleSummary = z.object({ id: z.uuid(), clientId: z.uuid(), relationshipEndedOn: date,
  retentionYears: z.number().int(), disposeAfter: date, governingRule: z.string(), currentHold: holdSummary.nullable(),
  recordedBy: z.uuid(), recordedAt: instant });
const holdEvent = z.object({ id: z.uuid(), action: z.enum(['imposed','reviewed','released']), reviewOn: date.nullable(),
  authority: z.string(), reason: z.string(), recordedBy: z.uuid(), recordedAt: instant });
const schedule = scheduleSummary.omit({ currentHold: true }).extend({ evidence: z.string(), holds: z.array(holdEvent) });
const scheduleList = z.object({ schedules: z.array(scheduleSummary) });
const createScheduleBody = z.strictObject({ clientId: z.uuid(), relationshipEndedOn: date,
  retentionYears: z.literal(5), governingRule: text(500, 10), evidence: text(10_000, 10) });
const holdBody = z.strictObject({ action: z.enum(['imposed','reviewed','released']), reviewOn: date.nullable().optional(),
  authority: text(500, 3), reason: text(10_000, 10) });
const disposal = z.object({ id: z.uuid(), scheduleId: z.uuid(), clientId: z.uuid(), governingRule: z.string(),
  state: z.enum(['prepared','completed']), preparedBy: z.uuid(), preparedAt: instant,
  completedBy: z.uuid().nullable(), completedAt: instant.nullable(), recordCount: z.number().int().nullable() });
const disposalList = z.object({ disposals: z.array(disposal) });
const exportSummary = z.object({ id: z.uuid(), clientId: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int(), createdBy: z.uuid(), createdAt: instant });
const exportList = z.object({ exports: z.array(exportSummary) });
const exportBody = z.strictObject({ clientId: z.uuid(), reason: text(500, 10) });
const restrictedExport = z.object({ id: z.uuid(), reportId: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/), byteSize: z.number().int() });
const restrictedExportBody = z.strictObject({ reason: text(500, 10) });

@Controller('compliance')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('access') @RequirePermission('aml.approve') @ResponseSchema(accessSchema)
  access(@CurrentSession() session: ResolvedSession) { return this.retention.access(session.account.id); }

  @Get('clients') @RequirePermission('aml.approve') @ResponseSchema(clientChoicesSchema)
  async clients(@CurrentSession() session: ResolvedSession) {
    return { clients: await this.retention.clientChoices(session.account.id) };
  }

  @Get('retention') @RequirePermission('aml.retention') @ResponseSchema(scheduleList)
  async schedules(@CurrentSession() session: ResolvedSession) {
    return { schedules: (await this.retention.listSchedules(session.account.id)).map((item) => ({
      ...item, currentHold: item.holdAction ? { action: item.holdAction, reviewOn: item.holdReviewOn } : null,
      recordedAt: item.recordedAt.toISOString(), holdAction: undefined, holdReviewOn: undefined,
    })) };
  }

  @Get('retention/disposals') @RequirePermission('aml.retention') @ResponseSchema(disposalList)
  async disposals(@CurrentSession() session: ResolvedSession) {
    return { disposals: (await this.retention.listDisposals(session.account.id)).map(serializeDisposal) };
  }

  @Post('retention') @RequirePermission('aml.retention') @ResponseSchema(schedule)
  async createSchedule(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    const parsed = createScheduleBody.safeParse(request.body);
    if (!parsed.success) throw new BadRequestException('Give a valid client, end date and retention basis');
    return changed(await this.retention.createSchedule(parsed.data, actorFor(session, request)), serializeSchedule);
  }

  @Get('retention/:scheduleId') @RequirePermission('aml.retention') @ResponseSchema(schedule)
  async findSchedule(@Param('scheduleId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession) {
    const found = await this.retention.findSchedule(id, session.account.id);
    if (!found) throw new NotFoundException('No retention schedule with this id');
    return serializeSchedule(found);
  }

  @Post('retention/:scheduleId/legal-holds') @RequirePermission('aml.retention') @ResponseSchema(schedule)
  async hold(@Param('scheduleId', { schema: z.uuid() }) id: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const parsed = holdBody.safeParse(request.body);
    if (!parsed.success || (parsed.data.action === 'released') !== (parsed.data.reviewOn == null)) {
      throw new BadRequestException('Give a valid legal-hold event, authority, reason and review date');
    }
    return changed(await this.retention.addHold(id, { ...parsed.data, reviewOn: parsed.data.reviewOn ?? null },
      actorFor(session, request)), serializeSchedule);
  }

  @Post('retention/:scheduleId/dispose') @RequirePermission('aml.retention') @ResponseSchema(disposal)
  async dispose(@Param('scheduleId', { schema: z.uuid() }) id: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.retention.dispose(id, actorFor(session, request)), serializeDisposal);
  }

  @Get('exports') @RequirePermission('aml.export') @ResponseSchema(exportList)
  async exports(@CurrentSession() session: ResolvedSession) {
    return { exports: (await this.retention.listExports(session.account.id)).map(serializeExport) };
  }

  @Post('exports') @RequirePermission('aml.export') @ResponseSchema(exportSummary)
  async createExport(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    const parsed = exportBody.safeParse(request.body);
    if (!parsed.success) throw new BadRequestException('Give a client and the regulatory purpose for this export');
    return changed(await this.retention.createExport(parsed.data.clientId, parsed.data.reason, actorFor(session, request)), serializeExport);
  }

  @Get('exports/:exportId/content') @RequirePermission('aml.export') @ResponseSchema(STREAMED)
  async downloadExport(@Param('exportId', { schema: z.uuid() }) id: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession, @Res() response: Response) {
    const found = await this.retention.downloadExport(id, actorFor(session, request));
    if (!found) throw new NotFoundException('No regulatory export with this id');
    sendJson(response, found.body, `aml-export-${id}.json`, found.sha256);
  }
}

@Controller('compliance/restricted-reports')
export class RestrictedExportsController {
  constructor(private readonly retention: RetentionService) {}

  @Post(':reportId/exports') @StaffOnly() @ResponseSchema(restrictedExport)
  async create(@Param('reportId', { schema: z.uuid() }) reportId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const parsed = restrictedExportBody.safeParse(request.body);
    if (!parsed.success) throw new BadRequestException('Give the regulatory purpose for this export');
    return changed(await this.retention.createRestrictedExport(reportId, parsed.data.reason, actorFor(session, request)), (value) => value);
  }

  @Get(':reportId/exports/:exportId/content') @StaffOnly() @ResponseSchema(STREAMED)
  async download(@Param('reportId', { schema: z.uuid() }) reportId: string,
    @Param('exportId', { schema: z.uuid() }) exportId: string, @CurrentSession() session: ResolvedSession,
    @Res() response: Response) {
    try {
      const found = await this.retention.downloadRestrictedExport(reportId, exportId, session.account.id);
      if (!found) throw new NotFoundException('No restricted export with this id');
      sendJson(response, found.body, `restricted-export-${exportId}.json`, found.sha256);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof Error && 'code' in error && error.code === '42501') {
        throw new NotFoundException('No restricted export with this id');
      }
      throw error;
    }
  }
}

function actorFor(session: ResolvedSession, request: Request): ComplianceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
function changed<T, R>(result: { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' }, serialize: (value: T) => R): R {
  if (result.outcome !== 'changed') {
    if (result.outcome === 'not_found') throw new NotFoundException('The compliance record is not available');
    throw new ConflictException('The compliance record cannot be changed in its current state');
  }
  return serialize(result.value);
}
function serializeSchedule(value: Awaited<ReturnType<RetentionService['findSchedule']>> & {}) {
  return { ...value, recordedAt: value.recordedAt.toISOString(),
    holds: value.holds.map((hold) => ({ ...hold, recordedAt: hold.recordedAt.toISOString() })) };
}
function serializeDisposal(value: DisposalRunLike) {
  return { ...value, preparedAt: value.preparedAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null };
}
type DisposalRunLike = Awaited<ReturnType<RetentionService['listDisposals']>>[number];
function serializeExport(value: ExportSummaryLike) { return { ...value, createdAt: value.createdAt.toISOString() }; }
type ExportSummaryLike = Awaited<ReturnType<RetentionService['listExports']>>[number];
function sendJson(response: Response, body: Buffer, fileName: string, sha256: string) {
  response.status(200).set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length), 'Content-Disposition': attachmentDisposition(fileName),
    'Digest': `sha-256=${Buffer.from(sha256, 'hex').toString('base64')}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).end(body);
}
