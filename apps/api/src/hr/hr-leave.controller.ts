import { BadRequestException, ConflictException, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { HrLeaveService, type HrLeaveChange } from './hr-leave.service.js';
import { HrService, type HrActor } from './hr.service.js';

const id = z.uuid(), date = z.iso.date(), dateTime = z.iso.datetime({ offset: true });
const changeSchema = z.object({ id, minutes: z.number().int().optional(), minutesReturned: z.number().int().optional() });
const policyBody = z.strictObject({ effectiveFrom: date, leaveYearMonth: z.number().int().min(1).max(12),
  leaveYearDay: z.number().int().min(1).max(28), standardEntitlementMinutes: z.number().int().positive().max(1_000_000),
  carryOverLimitMinutes: z.number().int().min(0).max(1_000_000), bookingNoticeDays: z.number().int().min(0).max(366),
  annualApprovalRoute: z.enum(['manager_or_hr', 'hr_only']) });
const policySchema = z.object({ id, version: z.number().int(), effectiveFrom: date,
  leaveYearMonth: z.number().int(), leaveYearDay: z.number().int(), standardEntitlementMinutes: z.number().int(),
  carryOverLimitMinutes: z.number().int(), bookingNoticeDays: z.number().int(),
  annualApprovalRoute: z.enum(['manager_or_hr', 'hr_only']), recordedBy: id, recordedAt: dateTime });
const policiesSchema = z.object({ policies: z.array(policySchema) });
const entitlementBody = z.strictObject({ leaveYearStart: date,
  kind: z.enum(['opening_grant', 'accrual', 'adjustment', 'carry_over', 'leaving_adjustment']),
  minutes: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0), reason: text(10_000, 3) });
const requestBody = z.strictObject({ kind: z.enum(['annual', 'family', 'compassionate', 'unpaid', 'other']),
  startsOn: date, endsOn: date, reason: text(10_000, 3) });
const decisionBody = z.strictObject({ action: z.enum(['approved', 'refused']), reason: text(10_000, 3) });
const reasonBody = z.strictObject({ reason: text(10_000, 3) });
const payBody = z.strictObject({ requestId: id, periodStartsOn: date, periodEndsOn: date,
  amountPence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), basis: z.enum(['normal', 'basic', 'rolled_up', 'other']),
  includedElements: z.array(z.strictObject({ name: text(100),
    amountPence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })).min(1).max(20) })
  .refine((value) => value.includedElements.reduce((sum, element) => sum + element.amountPence, 0) === value.amountPence,
    'Holiday-pay elements must total the recorded amount');
const sicknessBody = z.strictObject({ startedOn: date, endedOn: date.nullable().optional(), notifiedAt: dateTime,
  fitnessStatus: z.enum(['fit', 'not_fit', 'may_be_fit', 'not_assessed']) })
  .transform((value) => ({ ...value, endedOn: value.endedOn ?? null }));
const healthBody = z.strictObject({ kind: z.enum(['sickness_detail', 'fit_note', 'occupational_health', 'adjustment_ground']),
  validFrom: date.nullable().optional(), validTo: date.nullable().optional(), details: text(25_000, 3) })
  .transform((value) => ({ ...value, validFrom: value.validFrom ?? null, validTo: value.validTo ?? null }));
const adjustmentBody = z.strictObject({ request: text(25_000, 3) });
const adjustmentDecisionBody = z.strictObject({ outcome: z.enum(['agreed', 'refused']), reason: text(25_000, 3),
  operationalInstruction: text(25_000, 3).nullable().optional(), effectiveOn: date.nullable().optional(),
  reviewOn: date.nullable().optional() }).transform((value) => ({ ...value,
    operationalInstruction: value.operationalInstruction ?? null, effectiveOn: value.effectiveOn ?? null,
    reviewOn: value.reviewOn ?? null })).refine((value) => value.outcome === 'agreed'
      ? value.operationalInstruction !== null && value.effectiveOn !== null
      : value.operationalInstruction === null && value.effectiveOn === null && value.reviewOn === null,
    'Agreed adjustments need an operational instruction and effective date; refused adjustments must not include them');
const progressBody = z.strictObject({ action: z.enum(['implemented', 'reviewed', 'closed']), note: text(10_000, 3) });

const leaveRequestSchema = z.object({ id, personId: id, policyId: id,
  kind: z.enum(['annual', 'family', 'compassionate', 'unpaid', 'other']),
  startsOn: date, endsOn: date, leaveYearStart: date, reason: z.string(), submittedBy: id, submittedAt: dateTime,
  state: z.enum(['pending', 'approved', 'refused', 'cancelled']), decisionReason: z.string().nullable(),
  decidedBy: id.nullable(), decidedAt: dateTime.nullable(), approvedMinutes: z.number().int() });
const leaveSchema = z.object({ requests: z.array(leaveRequestSchema), balanceMinutes: z.number().int(),
  entitlement: z.array(z.object({ id, leaveYearStart: date,
    kind: z.enum(['opening_grant', 'accrual', 'adjustment', 'carry_over', 'consumption', 'cancellation_return', 'leaving_adjustment']),
    minutes: z.number().int(), leaveRequestId: id.nullable(), reason: z.string(),
    recordedBy: id, recordedAt: dateTime })),
  holidayPay: z.array(z.object({ id, leaveRequestId: id, periodStartsOn: date, periodEndsOn: date,
    amountPence: z.number().int(), basis: z.enum(['normal', 'basic', 'rolled_up', 'other']),
    includedElements: z.array(z.object({ name: z.string(), amountPence: z.number().int() })),
    retentionUntil: date, recordedBy: id, recordedAt: dateTime })),
  sickness: z.array(z.object({ id, startedOn: date, endedOn: date.nullable(), notifiedAt: dateTime,
    fitnessStatus: z.enum(['fit', 'not_fit', 'may_be_fit', 'not_assessed']), recordedBy: id, recordedAt: dateTime })) });
const pendingSchema = z.object({ requests: z.array(leaveRequestSchema.extend({ accountId: id, displayName: z.string() })) });
const healthSchema = z.object({ records: z.array(z.object({ id,
  kind: z.enum(['sickness_detail', 'fit_note', 'occupational_health', 'adjustment_ground']), validFrom: date.nullable(),
  validTo: date.nullable(), details: z.unknown(), recordedBy: id, recordedAt: dateTime })) });
const adjustmentsSchema = z.object({ adjustments: z.array(z.object({ requestId: id, personId: id,
  request: z.string().nullable(), submittedBy: id, submittedAt: dateTime, decisionId: id.nullable(),
  outcome: z.enum(['agreed', 'refused']).nullable(), decisionReason: z.string().nullable(),
  operationalInstruction: z.string().nullable(), effectiveOn: date.nullable(), reviewOn: date.nullable(),
  decidedBy: id.nullable(), decidedAt: dateTime.nullable() })), progress: z.array(z.object({ id,
  decisionId: id, action: z.enum(['implemented', 'reviewed', 'closed']), note: z.string(), recordedBy: id,
  recordedAt: dateTime })) });

@Controller('hr')
export class HrLeaveController {
  constructor(private readonly leave: HrLeaveService, private readonly hr: HrService) {}

  @Get('leave/policies') @RequirePermission('hr.leave') @ResponseSchema(policiesSchema)
  async policies(@CurrentSession() session: ResolvedSession) { return json({ policies: await this.leave.policies(session.account.id) }); }

  @Post('leave/policies') @RequirePermission('hr.leave') @ResponseSchema(changeSchema)
  async createPolicy(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.createPolicy(parse(policyBody, request.body), actorFor(session, request)));
  }

  @Get('leave/requests') @RequirePermission('hr.leave') @ResponseSchema(pendingSchema)
  async pending(@CurrentSession() session: ResolvedSession) {
    return json({ requests: await this.leave.pendingRequests(session.account.id) });
  }

  @Post('leave/requests/:requestId/decision') @StaffOnly() @ResponseSchema(changeSchema)
  async decideLeave(@Param('requestId', { schema: id }) requestId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.decideRequest(requestId, parse(decisionBody, request.body), actorFor(session, request)));
  }

  @Post('leave/requests/:requestId/cancel') @StaffOnly() @ResponseSchema(changeSchema)
  async cancelLeave(@Param('requestId', { schema: id }) requestId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.cancelRequest(requestId, parse(reasonBody, request.body), actorFor(session, request)));
  }

  @Get('me/leave') @StaffOnly() @ResponseSchema(leaveSchema)
  async ownLeave(@CurrentSession() session: ResolvedSession) {
    return found(await this.leave.leave(await this.ownPerson(session.account.id), session.account.id));
  }

  @Post('me/leave') @StaffOnly() @ResponseSchema(changeSchema)
  async requestOwnLeave(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.createRequest(await this.ownPerson(session.account.id), parse(requestBody, request.body),
      actorFor(session, request)));
  }

  @Get('reports/:personId/leave') @StaffOnly() @ResponseSchema(leaveSchema)
  async reportLeave(@Param('personId', { schema: id }) personId: string, @CurrentSession() session: ResolvedSession) {
    return found(await this.leave.leave(personId, session.account.id, true));
  }

  @Get('people/:personId/leave') @RequirePermission('hr.leave') @ResponseSchema(leaveSchema)
  async personLeave(@Param('personId', { schema: id }) personId: string, @CurrentSession() session: ResolvedSession) {
    return found(await this.leave.leave(personId, session.account.id));
  }

  @Post('people/:personId/leave') @RequirePermission('hr.leave') @ResponseSchema(changeSchema)
  async requestPersonLeave(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.createRequest(personId, parse(requestBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/leave/entitlement') @RequirePermission('hr.leave') @ResponseSchema(changeSchema)
  async entitlement(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.recordEntitlement(personId, parse(entitlementBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/leave/holiday-pay') @RequirePermission('hr.leave') @ResponseSchema(changeSchema)
  async holidayPay(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.recordHolidayPay(personId, parse(payBody, request.body), actorFor(session, request)));
  }

  @Post('people/:personId/sickness') @StaffOnly() @ResponseSchema(changeSchema)
  async sickness(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.recordSickness(personId, parse(sicknessBody, request.body), actorFor(session, request)));
  }

  @Get('people/:personId/health') @RequirePermission('hr.health') @ResponseSchema(healthSchema)
  async health(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    const records = await this.leave.health(personId, actorFor(session, request));
    if (!records) throw new NotFoundException('The HR health record is not available');
    return json({ records });
  }

  @Get('me/health') @StaffOnly() @ResponseSchema(healthSchema)
  async ownHealth(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    const records = await this.leave.health(await this.ownPerson(session.account.id), actorFor(session, request));
    if (!records) throw new NotFoundException('The HR health record is not available');
    return json({ records });
  }

  @Post('people/:personId/health') @RequirePermission('hr.health') @ResponseSchema(changeSchema)
  async recordHealth(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.recordHealth(personId, parse(healthBody, request.body), actorFor(session, request)));
  }

  @Get('me/adjustments') @StaffOnly() @ResponseSchema(adjustmentsSchema)
  async ownAdjustments(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return found(await this.leave.adjustments(await this.ownPerson(session.account.id), actorFor(session, request), false));
  }

  @Post('me/adjustments') @StaffOnly() @ResponseSchema(changeSchema)
  async requestAdjustment(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.createAdjustment(await this.ownPerson(session.account.id),
      parse(adjustmentBody, request.body), actorFor(session, request)));
  }

  @Get('reports/:personId/adjustments') @StaffOnly() @ResponseSchema(adjustmentsSchema)
  async reportAdjustments(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return found(await this.leave.adjustments(personId, actorFor(session, request), true));
  }

  @Get('people/:personId/adjustments') @RequirePermission('hr.health') @ResponseSchema(adjustmentsSchema)
  async personAdjustments(@Param('personId', { schema: id }) personId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return found(await this.leave.adjustments(personId, actorFor(session, request), false));
  }

  @Post('adjustments/:requestId/decision') @RequirePermission('hr.health') @ResponseSchema(changeSchema)
  async decideAdjustment(@Param('requestId', { schema: id }) requestId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.decideAdjustment(requestId, parse(adjustmentDecisionBody, request.body),
      actorFor(session, request)));
  }

  @Post('adjustments/decisions/:decisionId/progress') @StaffOnly() @ResponseSchema(changeSchema)
  async adjustmentProgress(@Param('decisionId', { schema: id }) decisionId: string, @Req() request: Request,
    @CurrentSession() session: ResolvedSession) {
    return changed(await this.leave.recordAdjustmentProgress(decisionId, parse(progressBody, request.body),
      actorFor(session, request)));
  }

  private async ownPerson(accountId: string): Promise<string> {
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
  if (!result.success) throw new BadRequestException('Give valid HR leave or health details');
  return result.data;
}
function changed<T>(result: HrLeaveChange<T>): T {
  if (result.outcome === 'changed') return json(result.value);
  if (result.outcome === 'not_found') throw new NotFoundException('The HR record is not available');
  throw new ConflictException('The HR record cannot be changed in its current state');
}
function found<T>(value: T | undefined): T {
  if (!value) throw new NotFoundException('The HR record is not available');
  return json(value);
}
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
