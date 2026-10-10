import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import type { ControlVersion, IndependentReview, OfficerAppointment, TrainingCompletion } from './compliance.js';
import { ComplianceService, type ComplianceActor } from './compliance.service.js';

const date = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31', 'Date is outside the supported range');
const pageQuery = z.strictObject({ before: z.uuid().optional() });
const person = z.object({ accountId: z.uuid(), displayName: z.string() });
const officerKind = z.enum(['nominated_officer', 'deputy']);
const controlKind = z.enum(['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
  'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy', 'training_material']);
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
  reviewDueOn: date, preparedBy: person, preparedAt: z.iso.datetime(), approval: approval.nullable() });
const controlList = z.object({ controls: z.array(control), next: z.uuid().nullable() });
const controlBody = z.strictObject({ kind: controlKind, title: text(200), content: documentText(200_000),
  source: text(2_000), effectiveFrom: date, reviewDueOn: date });

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
const serializeTraining = (value: TrainingCompletion) => ({
  ...value, recordedAt: value.recordedAt.toISOString(),
});
const serializeReview = (value: IndependentReview) => ({
  ...value, recordedAt: value.recordedAt.toISOString(),
});

@Controller('compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('officers') @RequirePermission('aml.officers.manage') @ResponseSchema(appointmentList)
  async officers(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listAppointments(query.before);
    return { appointments: page.items.map(serializeAppointment), next: page.next };
  }

  @Post('officers') @RequirePermission('aml.officers.manage') @ResponseSchema(appointment)
  async appoint(@Body({ schema: appointmentBody }) body: z.infer<typeof appointmentBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.appoint(body.accountId, body.kind, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The appointment is not valid or already active');
    return serializeAppointment(result.value);
  }

  @Post('officers/:appointmentId/end') @RequirePermission('aml.officers.manage') @ResponseSchema(appointment)
  async end(@Param('appointmentId', { schema: z.uuid() }) id: string,
    @Body({ schema: endBody }) body: z.infer<typeof endBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.endAppointment(id, body.reason, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No officer appointment with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This appointment cannot be ended');
    return serializeAppointment(result.value);
  }

  @Get('controls') @RequirePermission('aml.firm_controls') @ResponseSchema(controlList)
  async controls(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listControls(false, query.before);
    return { controls: page.items.map(serializeControl), next: page.next };
  }

  @Get('controls/pending-approval') @RequirePermission('aml.firm_approve') @ResponseSchema(controlList)
  async pendingControls(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listControls(true, query.before);
    return { controls: page.items.map(serializeControl), next: page.next };
  }

  @Get('controls/:controlId') @RequirePermission('aml.firm_controls') @ResponseSchema(control)
  async findControl(@Param('controlId', { schema: z.uuid() }) id: string) {
    const value = await this.compliance.findControl(id);
    if (!value) throw new NotFoundException('No firm-control version with this id');
    return serializeControl(value);
  }

  @Post('controls') @RequirePermission('aml.firm_controls') @ResponseSchema(control)
  async createControl(@Body({ schema: controlBody }) body: z.infer<typeof controlBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.createControl(body, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The firm-control version is not valid');
    return serializeControl(result.value);
  }

  @Post('controls/:controlId/approval') @RequirePermission('aml.firm_approve') @ResponseSchema(control)
  async approveControl(@Param('controlId', { schema: z.uuid() }) id: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.approveControl(id, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No firm-control version with this id');
    if (result.outcome === 'conflict') throw new ConflictException('This version cannot be approved');
    return serializeControl(result.value);
  }

  @Post('training') @StaffOnly() @ResponseSchema(training)
  async recordTraining(@Body({ schema: trainingBody }) body: z.infer<typeof trainingBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.recordTraining({ ...body, accountId: body.accountId ?? session.account.id }, actorFor(session, request));
    if (result.outcome === 'not_found') throw new NotFoundException('No training material or staff account with this id');
    if (result.outcome === 'conflict') throw new ConflictException('Training needs approved material and may be recorded only once');
    return serializeTraining(result.value);
  }

  @Get('training/me') @StaffOnly() @ResponseSchema(trainingList)
  async ownTraining(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>, @CurrentSession() session: ResolvedSession) {
    const page = await this.compliance.listTraining(session.account.id, query.before);
    return { completions: page.items.map(serializeTraining), next: page.next };
  }

  @Get('training') @RequirePermission('aml.firm_controls') @ResponseSchema(trainingList)
  async training(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listTraining(undefined, query.before);
    return { completions: page.items.map(serializeTraining), next: page.next };
  }

  @Post('independent-reviews') @RequirePermission('aml.firm_controls') @ResponseSchema(review)
  async recordReview(@Body({ schema: reviewBody }) body: z.infer<typeof reviewBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.compliance.recordReview({ ...body, reviewerOrganisation: body.reviewerOrganisation ?? null }, actorFor(session, request));
    if (result.outcome !== 'changed') throw new ConflictException('The independent-review record is not valid');
    return serializeReview(result.value);
  }

  @Get('independent-reviews') @RequirePermission('aml.firm_controls') @ResponseSchema(reviewList)
  async reviews(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.compliance.listReviews(query.before);
    return { reviews: page.items.map(serializeReview), next: page.next };
  }
}
