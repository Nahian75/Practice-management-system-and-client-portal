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
import { HrCasesRetentionService, type ExportScope, type HrChange } from './hr-cases-retention.service.js';
import type { HrActor } from './hr.service.js';

const id = z.uuid(), date = z.iso.date(), instant = z.iso.datetime({ offset: true });
const caseKind = z.enum(['grievance','disciplinary','capability']);
const caseRole = z.enum(['hr_member','investigator','decision_maker','appeal_officer']);
const caseState = z.enum(['open','investigating','decision_due','appeal_open','closed']);
const category = z.enum(['personal','employment','leave','health','right_to_work','competence','case']);
const exportScope = z.enum(['personal','employment','leave','health','vetting','competence','cases']);
const changeSchema = z.object({ id });
const caseSummary = z.object({ id, personId: id, kind: caseKind, dueOn: date.nullable(), state: caseState, openedAt: instant });
const member = z.object({ id, accountId: id, role: caseRole, separationOverride: z.string().nullable(), addedBy: id,
  addedAt: instant, ending: z.object({ id, reason: z.string(), endedBy: id, endedAt: instant }).nullable() });
const caseEvent = z.object({ id, kind: z.enum(['evidence','meeting','response','notice','outcome','action','appeal','correction','status']),
  state: caseState.nullable(), occurredOn: date, supersedesEventId: id.nullable(), summary: z.string(), details: z.string(),
  evidenceReference: z.string().nullable(), recordedBy: id, recordedAt: instant });
const caseDetail = z.object({ id, personId: id, kind: caseKind, raisedByPersonId: id.nullable(), policyVersion: z.string(),
  dueOn: date.nullable(), issue: z.string(), openedBy: id, openedAt: instant, members: z.array(member), events: z.array(caseEvent) });
const caseList = z.object({ cases: z.array(caseSummary) });
const accessList = z.object({ accesses: z.array(z.object({ id, action: z.enum(['view','export']), accessedBy: id, accessedAt: instant })) });
const createCaseBody = z.strictObject({ personId: id, kind: caseKind, raisedByPersonId: id.nullable().optional(),
  policyVersion: text(200), dueOn: date.nullable().optional(), issue: text(50_000, 3) }).transform((value) => ({
    ...value, raisedByPersonId: value.raisedByPersonId ?? null, dueOn: value.dueOn ?? null }));
const memberBody = z.strictObject({ accountId: id, role: caseRole,
  separationOverride: text(10_000, 10).nullable().optional() }).transform((value) => ({
    ...value, separationOverride: value.separationOverride ?? null }));
const endingBody = z.strictObject({ reason: text(10_000, 3) });
const eventBody = z.strictObject({ kind: z.enum(['evidence','meeting','response','notice','outcome','action','appeal','correction','status']),
  state: caseState.nullable().optional(), occurredOn: date, supersedesEventId: id.nullable().optional(),
  summary: text(500, 3), details: text(50_000, 3), evidenceReference: text(1000).nullable().optional() })
  .transform((value) => ({ ...value, state: value.state ?? null, supersedesEventId: value.supersedesEventId ?? null,
    evidenceReference: value.evidenceReference ?? null }))
  .refine((value) => (value.kind === 'status') === (value.state !== null), 'Only status events have a state')
  .refine((value) => (value.kind === 'correction') === (value.supersedesEventId !== null), 'A correction names the event it corrects');

const rule = z.object({ id, category, version: z.number().int(), effectiveFrom: date, reviewAfterMonths: z.number().int(),
  retainMonths: z.number().int(), governingRule: z.string(), rationale: z.string(), recordedBy: id, recordedAt: instant });
const ruleList = z.object({ rules: z.array(rule) });
const ruleBody = z.strictObject({ category, effectiveFrom: date, reviewAfterMonths: z.number().int().min(1).max(1200),
  retainMonths: z.number().int().min(1).max(1200), governingRule: text(500, 10), rationale: text(10_000, 10) })
  .refine((value) => value.reviewAfterMonths <= value.retainMonths, 'Review cannot follow disposal');
const holdSummary = z.object({ action: z.enum(['imposed','reviewed','released']), reviewOn: date.nullable() });
const scheduleSummary = z.object({ id, personId: id, ruleId: id, category, sourceId: id.nullable(), basisOn: date,
  reviewOn: date, disposeAfter: date, ruleVersion: z.number().int(), governingRule: z.string(),
  currentHold: holdSummary.nullable(), recordedBy: id, recordedAt: instant });
const hold = holdSummary.extend({ id, authority: z.string(), reason: z.string(), recordedBy: id, recordedAt: instant });
const scheduleDetail = scheduleSummary.omit({ ruleVersion: true, governingRule: true, currentHold: true })
  .extend({ evidence: z.string(), holds: z.array(hold) });
const scheduleList = z.object({ schedules: z.array(scheduleSummary) });
const scheduleBody = z.strictObject({ personId: id, ruleId: id, sourceId: id.nullable().optional(), basisOn: date,
  evidence: text(10_000, 10) }).transform((value) => ({ ...value, sourceId: value.sourceId ?? null }));
const holdBody = z.strictObject({ action: z.enum(['imposed','reviewed','released']), reviewOn: date.nullable().optional(),
  authority: text(500, 3), reason: text(10_000, 10) }).transform((value) => ({ ...value, reviewOn: value.reviewOn ?? null }))
  .refine((value) => (value.action === 'released') === (value.reviewOn === null), 'Active holds need a review date');
const disposal = z.object({ id, scheduleId: id, personId: id, category, ruleVersion: z.number().int(),
  governingRule: z.string(), state: z.enum(['prepared','completed']), preparedBy: id, preparedAt: instant,
  completedBy: id.nullable(), completedAt: instant.nullable(), recordCount: z.number().int().nullable() });
const disposalList = z.object({ disposals: z.array(disposal) });

const exportSummary = z.object({ id, personId: id, purpose: z.enum(['worker_access','litigation','regulator']),
  scopes: z.array(exportScope), caseIds: z.array(id), sha256: z.string().regex(/^[0-9a-f]{64}$/), byteSize: z.number().int(),
  createdBy: id, createdAt: instant, decision: z.enum(['approved','rejected']).nullable(),
  decidedBy: id.nullable(), decidedAt: instant.nullable() });
const exportList = z.object({ exports: z.array(exportSummary) });
const exportBody = z.strictObject({ personId: id, purpose: z.enum(['worker_access','litigation','regulator']),
  scopes: z.array(exportScope).min(1).max(7).refine((items) => new Set(items).size === items.length), reason: text(1000, 10) });
const exportDecisionBody = z.strictObject({ decision: z.enum(['approved','rejected']), note: text(10_000, 10) });
const exportPreview = z.object({ id, sha256: z.string().regex(/^[0-9a-f]{64}$/), bundle: z.unknown() });

@Controller('hr')
export class HrCasesRetentionController {
  constructor(private readonly service: HrCasesRetentionService) {}

  @Get('cases') @StaffOnly() @ResponseSchema(caseList)
  async cases(@CurrentSession() session: ResolvedSession) { return json({ cases: await this.service.listCases(session.account.id) }); }

  @Post('cases') @RequirePermission('hr.cases') @ResponseSchema(changeSchema)
  async createCase(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.createCase(parse(createCaseBody, request.body), actorFor(session, request)));
  }

  @Get('cases/:caseId') @StaffOnly() @ResponseSchema(caseDetail)
  async case(@Param('caseId', { schema: id }) caseId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const value = await this.service.case(caseId, actorFor(session, request));
    if (!value) throw new NotFoundException('The HR case is not available'); return json(value);
  }

  @Post('cases/:caseId/members') @StaffOnly() @ResponseSchema(changeSchema)
  async addMember(@Param('caseId', { schema: id }) caseId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.addMember(caseId, parse(memberBody, request.body), actorFor(session, request)));
  }

  @Post('case-memberships/:membershipId/end') @StaffOnly() @ResponseSchema(changeSchema)
  async endMember(@Param('membershipId', { schema: id }) membershipId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.endMember(membershipId, parse(endingBody, request.body).reason, actorFor(session, request)));
  }

  @Post('cases/:caseId/events') @StaffOnly() @ResponseSchema(changeSchema)
  async addEvent(@Param('caseId', { schema: id }) caseId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.addEvent(caseId, parse(eventBody, request.body), actorFor(session, request)));
  }

  @Get('cases/:caseId/accesses') @StaffOnly() @ResponseSchema(accessList)
  async accesses(@Param('caseId', { schema: id }) caseId: string, @CurrentSession() session: ResolvedSession) {
    const value = await this.service.accesses(caseId, session.account.id);
    if (!value) throw new NotFoundException('The HR case is not available'); return json({ accesses: value });
  }

  @Get('retention/rules') @RequirePermission('hr.retention') @ResponseSchema(ruleList)
  async rules(@CurrentSession() session: ResolvedSession) { return json({ rules: await this.service.rules(session.account.id) }); }

  @Post('retention/rules') @RequirePermission('hr.retention') @ResponseSchema(changeSchema)
  async createRule(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.createRule(parse(ruleBody, request.body), actorFor(session, request)));
  }

  @Get('retention/schedules') @RequirePermission('hr.retention') @ResponseSchema(scheduleList)
  async schedules(@CurrentSession() session: ResolvedSession) { return json({ schedules: await this.service.schedules(session.account.id) }); }

  @Post('retention/schedules') @RequirePermission('hr.retention') @ResponseSchema(changeSchema)
  async createSchedule(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.createSchedule(parse(scheduleBody, request.body), actorFor(session, request)));
  }

  @Get('retention/schedules/:scheduleId') @RequirePermission('hr.retention') @ResponseSchema(scheduleDetail)
  async schedule(@Param('scheduleId', { schema: id }) scheduleId: string, @CurrentSession() session: ResolvedSession) {
    const value = await this.service.schedule(scheduleId, session.account.id);
    if (!value) throw new NotFoundException('The HR retention schedule is not available'); return json(value);
  }

  @Post('retention/schedules/:scheduleId/legal-holds') @RequirePermission('hr.retention') @ResponseSchema(changeSchema)
  async hold(@Param('scheduleId', { schema: id }) scheduleId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.addHold(scheduleId, parse(holdBody, request.body), actorFor(session, request)));
  }

  @Get('retention/disposals') @RequirePermission('hr.retention') @ResponseSchema(disposalList)
  async disposals(@CurrentSession() session: ResolvedSession) { return json({ disposals: await this.service.disposals(session.account.id) }); }

  @Post('retention/schedules/:scheduleId/dispose') @RequirePermission('hr.retention') @ResponseSchema(disposal)
  async dispose(@Param('scheduleId', { schema: id }) scheduleId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return json(changed(await this.service.dispose(scheduleId, actorFor(session, request))));
  }

  @Get('exports') @RequirePermission('hr.export') @ResponseSchema(exportList)
  async exports(@CurrentSession() session: ResolvedSession) { return json({ exports: await this.service.exports(session.account.id) }); }

  @Post('exports') @RequirePermission('hr.export') @ResponseSchema(exportSummary)
  async createExport(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    const value = parse(exportBody, request.body) as { personId: string; purpose: 'worker_access' | 'litigation' | 'regulator';
      scopes: ExportScope[]; reason: string };
    return json(changed(await this.service.createExport(value, actorFor(session, request))));
  }

  @Get('exports/:exportId/review') @RequirePermission('hr.export') @ResponseSchema(exportPreview)
  async preview(@Param('exportId', { schema: id }) exportId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const value = await this.service.previewExport(exportId, actorFor(session, request));
    if (!value) throw new NotFoundException('The HR export is not available'); return value;
  }

  @Post('exports/:exportId/decision') @RequirePermission('hr.export') @ResponseSchema(changeSchema)
  async decideExport(@Param('exportId', { schema: id }) exportId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.service.decideExport(exportId, parse(exportDecisionBody, request.body), actorFor(session, request)));
  }

  @Get('exports/:exportId/content') @RequirePermission('hr.export') @ResponseSchema(STREAMED)
  async download(@Param('exportId', { schema: id }) exportId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession, @Res() response: Response) {
    try {
      const value = await this.service.downloadExport(exportId, actorFor(session, request));
      if (!value) throw new NotFoundException('The HR export is not available');
      response.status(200).set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(value.body.length), 'Content-Disposition': attachmentDisposition(`hr-export-${exportId}.json`),
        'Digest': `sha-256=${Buffer.from(value.sha256, 'hex').toString('base64')}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).end(value.body);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23514') {
        throw new ConflictException('The HR export has not been approved for release');
      }
      throw error;
    }
  }
}

function actorFor(session: ResolvedSession, request: Request): HrActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new BadRequestException('Give valid HR case, retention or export details');
  return result.data;
}
function changed<T>(result: HrChange<T>): T {
  if (result.outcome === 'changed') return result.value;
  if (result.outcome === 'not_found') throw new NotFoundException('The HR record is not available');
  throw new ConflictException('The HR record cannot be changed in its current state');
}
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
