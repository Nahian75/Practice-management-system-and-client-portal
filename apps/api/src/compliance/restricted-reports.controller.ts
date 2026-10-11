import { BadRequestException, ConflictException, Controller, Get, HttpException, HttpStatus, NotFoundException,
  Param, Post, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { attachmentDisposition } from '../documents/content-disposition.js';
import { discardUpload, readUpload, UploadFormError } from '../documents/upload-request.js';
import type { ComplianceActor } from './compliance.service.js';
import { RestrictedReportsService } from './restricted-reports.service.js';
import type { RestrictedReport } from './restricted-reports.js';

const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const idOrNull = z.uuid().nullable().optional();
const submitBody = z.strictObject({ clientId: z.uuid(), matterId: idOrNull, financeTransactionId: idOrNull,
  observedOn: date, observedFacts: text(100_000, 20) });
const receiptSchema = z.object({ receiptId: z.uuid(), received: z.literal(true) });
const summary = z.object({ id: z.uuid(), observedOn: date, submittedAt: z.iso.datetime(), decided: z.boolean() });
const summaryPage = z.object({ reports: z.array(summary), next: z.uuid().nullable() });
const pageQuery = z.strictObject({ before: z.uuid().optional() });
const attachment = z.object({ id: z.uuid(), fileName: z.string(), mediaType: z.string(), sizeBytes: z.number().int(), uploadedAt: z.iso.datetime() });
const event = z.object({ id: z.uuid(), outcome: z.enum(['requested', 'granted', 'refused', 'withdrawn', 'expired']),
  receivedAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable(), externalReference: z.string(),
  permittedActivity: z.string().nullable(), legalBasis: z.string(), recordedBy: z.uuid(), recordedAt: z.iso.datetime() });
const reportSchema = z.object({ id: z.uuid(), clientId: z.uuid(), matterId: z.uuid().nullable(), financeTransactionId: z.uuid().nullable(),
  observedOn: date, observedFacts: z.string(), submittedBy: z.uuid(), submittedAt: z.iso.datetime(), attachments: z.array(attachment),
  decision: z.object({ id: z.uuid(), externalReportRequired: z.boolean(), legalGrounds: z.string(),
    decidedBy: z.uuid(), decidedAt: z.iso.datetime() }).nullable(),
  externalReport: z.object({ id: z.uuid(), kind: z.enum(['sar', 'terrorist_financing_report']), damlDatfRequested: z.boolean(),
    reference: z.string(), submittedAt: z.iso.datetime(), recordedAt: z.iso.datetime(), submittedBy: z.uuid(), events: z.array(event) }).nullable() });
const decisionBody = z.strictObject({ externalReportRequired: z.boolean(), legalGrounds: text(100_000, 20), imposeHold: z.boolean() });
const externalBody = z.strictObject({ kind: z.enum(['sar', 'terrorist_financing_report']), reference: text(500),
  submittedAt: instant, damlDatfRequested: z.boolean() });
const eventBody = z.strictObject({ outcome: z.enum(['requested', 'granted', 'refused', 'withdrawn', 'expired']),
  receivedAt: instant, expiresAt: instant.nullable().optional(), externalReference: text(500),
  permittedActivity: text(10_000).nullable().optional(), legalBasis: text(100_000, 20) });
const accessSchema = z.object({ accesses: z.array(z.object({ id: z.uuid(), action: z.enum(['view', 'download', 'export']),
  attachmentId: z.uuid().nullable(), accessedBy: z.uuid(), accessedAt: z.iso.datetime() })) });

@Controller('compliance/restricted-reports')
export class RestrictedReportsController {
  constructor(private readonly reports: RestrictedReportsService) {}

  /** JSON submits a report without a file; multipart submits the same fields followed by one protected attachment. */
  @Post() @RequirePermission('aml.internal_report') @ResponseSchema(receiptSchema)
  async submit(@CurrentSession() session: ResolvedSession, @Req() request: Request) {
    let candidate: unknown = request.body;
    let upload: Awaited<ReturnType<typeof readUpload>> | undefined;
    if (request.is('multipart/form-data')) {
      try {
        upload = await readUpload(request, ['clientId', 'matterId', 'financeTransactionId', 'observedOn', 'observedFacts']);
      } catch (error) {
        if (error instanceof UploadFormError) throw new BadRequestException(error.message);
        throw error;
      }
      candidate = { ...upload.fields, matterId: upload.fields['matterId'] || null,
        financeTransactionId: upload.fields['financeTransactionId'] || null };
    }
    const parsed = submitBody.safeParse(candidate);
    if (!parsed.success) {
      if (upload) discardUpload(upload.file);
      throw new BadRequestException('Give valid report facts and identifiers');
    }
    const result = await this.reports.submit({ ...parsed.data, matterId: parsed.data.matterId ?? null,
      financeTransactionId: parsed.data.financeTransactionId ?? null,
      ...(upload ? { attachment: { fileName: upload.fileName, file: upload.file } } : {}) }, actorFor(session, request));
    if (result.outcome !== 'submitted' && result.outcome !== 'refused') {
      if (result.outcome === 'not_found') throw new NotFoundException('The linked record is not available');
      throw new ConflictException('The internal report could not be accepted');
    }
    if (result.outcome === 'refused') {
      if (result.reason === 'scanner_unavailable') throw new ServiceUnavailableException('Attachments are paused because malware scanning is unavailable');
      if (result.reason === 'too_large') throw new HttpException('The attachment is too large', HttpStatus.PAYLOAD_TOO_LARGE);
      const status = result.reason === 'type' ? HttpStatus.UNSUPPORTED_MEDIA_TYPE : HttpStatus.UNPROCESSABLE_ENTITY;
      throw new HttpException('The protected attachment was refused', status);
    }
    return { receiptId: result.receiptId, received: true as const };
  }

  @Get() @StaffOnly() @ResponseSchema(summaryPage)
  async list(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>, @CurrentSession() session: ResolvedSession,
    @Res({ passthrough: true }) response: Response) {
    noStore(response);
    try {
      const page = await this.reports.list(session.account.id, query.before);
      return { reports: page.items.map((item) => ({ ...item, submittedAt: item.submittedAt.toISOString() })), next: page.next };
    } catch (error) { throw hidden(error); }
  }

  @Get(':reportId') @StaffOnly() @ResponseSchema(reportSchema)
  async find(@Param('reportId', { schema: z.uuid() }) reportId: string, @CurrentSession() session: ResolvedSession,
    @Res({ passthrough: true }) response: Response) {
    noStore(response);
    try {
      const report = await this.reports.find(reportId, session.account.id);
      if (!report) throw new NotFoundException('No restricted report with this id');
      return serialize(report);
    } catch (error) { throw hidden(error); }
  }

  @Post(':reportId/decision') @StaffOnly() @ResponseSchema(reportSchema)
  async decide(@Param('reportId', { schema: z.uuid() }) reportId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const parsed = decisionBody.safeParse(request.body);
    if (!parsed.success) throw new BadRequestException('Give a valid decision and legal grounds');
    return changed(await this.reports.decide(reportId, parsed.data, actorFor(session, request)));
  }

  @Post(':reportId/external-report') @StaffOnly() @ResponseSchema(reportSchema)
  async external(@Param('reportId', { schema: z.uuid() }) reportId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const parsed = externalBody.safeParse(request.body);
    if (!parsed.success) throw new BadRequestException('Give valid external report details');
    return changed(await this.reports.recordExternal(reportId, parsed.data, actorFor(session, request)));
  }

  @Post(':reportId/external-report/:externalId/events') @StaffOnly() @ResponseSchema(reportSchema)
  async event(@Param('reportId', { schema: z.uuid() }) reportId: string,
    @Param('externalId', { schema: z.uuid() }) externalId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const parsed = eventBody.safeParse(request.body);
    if (!parsed.success) throw new BadRequestException('Give a valid DAML/DATF status event');
    return changed(await this.reports.recordEvent(reportId, externalId, { ...parsed.data,
      expiresAt: parsed.data.expiresAt ?? null, permittedActivity: parsed.data.permittedActivity ?? null }, actorFor(session, request)));
  }

  @Get(':reportId/accesses') @StaffOnly() @ResponseSchema(accessSchema)
  async accesses(@Param('reportId', { schema: z.uuid() }) reportId: string, @CurrentSession() session: ResolvedSession,
    @Res({ passthrough: true }) response: Response) {
    noStore(response);
    try {
      return { accesses: (await this.reports.accessLog(reportId, session.account.id)).map((item) => ({ ...item,
        accessedAt: item.accessedAt.toISOString() })) };
    } catch (error) { throw hidden(error); }
  }

  @Get(':reportId/attachments/:attachmentId/content') @StaffOnly() @ResponseSchema(STREAMED)
  async download(@Param('reportId', { schema: z.uuid() }) reportId: string,
    @Param('attachmentId', { schema: z.uuid() }) attachmentId: string, @CurrentSession() session: ResolvedSession,
    @Res() response: Response) {
    let found;
    try { found = await this.reports.download(reportId, attachmentId, session.account.id); }
    catch (error) { throw hidden(error); }
    if (!found) throw new NotFoundException('No restricted attachment with this id');
    response.status(200).set({ 'Cache-Control': 'private, no-store', 'Content-Type': found.mediaType,
      'Content-Length': String(found.sizeBytes), 'Content-Disposition': attachmentDisposition(found.fileName),
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    found.file.on('error', () => response.destroy());
    found.file.pipe(response);
  }
}

function actorFor(session: ResolvedSession, request: Request): ComplianceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
function noStore(response: Response) { response.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); }
function hidden(error: unknown): Error {
  if (error instanceof HttpException) return error;
  if (error instanceof Error && 'code' in error && error.code === '42501') return new NotFoundException('No restricted report with this id');
  return error instanceof Error ? error : new Error('Restricted report request failed');
}
function changed(result: Awaited<ReturnType<RestrictedReportsService['decide']>>) {
  if (result.outcome !== 'changed') {
    if (result.outcome === 'not_found') throw new NotFoundException('No restricted report with this id');
    throw new ConflictException('This permanent record cannot be changed');
  }
  return serialize(result.value);
}
function serialize(report: RestrictedReport) {
  return { ...report, submittedAt: report.submittedAt.toISOString(),
    attachments: report.attachments.map((a) => ({ ...a, uploadedAt: a.uploadedAt.toISOString() })),
    decision: report.decision ? { ...report.decision, decidedAt: report.decision.decidedAt.toISOString() } : null,
    externalReport: report.externalReport ? { ...report.externalReport,
      submittedAt: report.externalReport.submittedAt.toISOString(), recordedAt: report.externalReport.recordedAt.toISOString(),
      events: report.externalReport.events.map((e) => ({ ...e, receivedAt: e.receivedAt.toISOString(),
        expiresAt: e.expiresAt?.toISOString() ?? null, recordedAt: e.recordedAt.toISOString() })) } : null };
}
