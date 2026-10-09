import { Body, ConflictException, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import type { StaffRate, TimeEntry, TimeValues } from './finance.js';
import { FinanceService, type FinanceActor } from './finance.service.js';
import { penceToPounds, poundsToPence } from './money.js';

const calendarDate = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31', 'Date is outside the supported range');
const hourlyRate = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/).refine((value) => BigInt(value.replace('.', '')) <= 1_000_000n, 'Hourly rate must not exceed 10000.00');
const personSchema = z.object({ accountId: z.uuid(), displayName: z.string() });
const rateSchema = z.object({
  id: z.uuid(),
  account: personSchema,
  hourlyRate: z.string(),
  effectiveFrom: calendarDate,
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
});
const timeValuesSchema = z.object({ workedOn: calendarDate, minutes: z.number().int(), description: z.string(), hourlyRate: z.string() });
const correctionSchema = z.object({
  id: z.uuid(),
  from: timeValuesSchema,
  to: timeValuesSchema.nullable(),
  reason: z.string(),
  correctedBy: personSchema,
  correctedAt: z.iso.datetime(),
});
const timeSchema = timeValuesSchema.extend({
  id: z.uuid(),
  matterId: z.uuid(),
  worker: personSchema,
  voided: z.boolean(),
  recordedAt: z.iso.datetime(),
  corrections: z.array(correctionSchema),
});
const timeListItemSchema = timeSchema.omit({ description: true, corrections: true });
const rateBodySchema = z.strictObject({ accountId: z.uuid(), hourlyRate, effectiveFrom: calendarDate });
const rateQuerySchema = z.strictObject({ accountId: z.uuid().optional(), before: z.uuid().optional() });
const rateListSchema = z.object({ rates: z.array(rateSchema), next: z.uuid().nullable() });
const timeBodySchema = z.strictObject({ workedOn: calendarDate, minutes: z.number().int().min(1).max(1440), description: text(1_000) });
const timeListQuerySchema = z.strictObject({ before: z.uuid().optional() });
const timeListSchema = z.object({ timeEntries: z.array(timeListItemSchema), next: z.uuid().nullable() });
const correctionBodySchema = z.strictObject({ replacement: timeBodySchema.nullable(), reason: text(500) });
const rateAccountsSchema = z.object({ accounts: z.array(z.object({
  accountId: z.uuid(), displayName: z.string(), roles: z.array(z.enum(['partner', 'fee_earner'])),
})) });

function actorFor(session: ResolvedSession, request: Request): FinanceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

function responseRate(rate: StaffRate) {
  return { ...rate, hourlyRate: penceToPounds(rate.hourlyRatePence), hourlyRatePence: undefined, createdAt: rate.createdAt.toISOString() };
}

function responseValues(values: TimeValues) {
  return { ...values, hourlyRate: penceToPounds(values.hourlyRatePence), hourlyRatePence: undefined };
}

function responseTime(entry: TimeEntry) {
  return {
    ...responseValues(entry),
    corrections: entry.corrections.map((correction) => ({
      ...correction,
      from: responseValues(correction.from),
      to: correction.to && responseValues(correction.to),
      correctedAt: correction.correctedAt.toISOString(),
    })),
    recordedAt: entry.recordedAt.toISOString(),
  };
}

function responseTimeListItem(entry: TimeEntry) {
  const { description: _description, corrections: _corrections, ...item } = responseTime(entry);
  return item;
}

@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Post('finance/rates')
  @RequirePermission('rates.manage')
  @ResponseSchema(rateSchema)
  async createRate(
    @Body({ schema: rateBodySchema }) body: z.infer<typeof rateBodySchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.finance.createRate({
      accountId: body.accountId,
      hourlyRatePence: poundsToPence(body.hourlyRate),
      effectiveFrom: body.effectiveFrom,
    }, actorFor(session, request));
    switch (result.outcome) {
      case 'invalid_account':
        throw new ConflictException('Rates need an active partner or fee earner');
      case 'duplicate':
        throw new ConflictException('A rate already starts on this date');
      case 'changed_meanwhile':
        throw new ConflictException('The staff account or role changed meanwhile. Reload and try again');
      case 'created':
        return responseRate(result.rate);
    }
  }

  @Get('finance/rate-accounts')
  @RequirePermission('rates.manage')
  @ResponseSchema(rateAccountsSchema)
  async rateAccounts() {
    return { accounts: await this.finance.rateAccounts() };
  }

  @Get('finance/rates')
  @RequirePermission('finance.view_all')
  @ResponseSchema(rateListSchema)
  async listRates(@Query({ schema: rateQuerySchema }) query: z.infer<typeof rateQuerySchema>) {
    const page = await this.finance.listRates(query.accountId, query.before);
    return { rates: page.rates.map(responseRate), next: page.next };
  }

  @Post('matters/:matterId/time-entries')
  @RequirePermission('time.record')
  @ResponseSchema(timeSchema)
  async recordTime(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: timeBodySchema }) body: z.infer<typeof timeBodySchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.finance.recordTime(matterId, body, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException('No matter with this id');
      case 'not_open':
        throw new ConflictException('Time is recorded only on open matters');
      case 'missing_rate':
        throw new ConflictException('No staff rate applies on this date');
      case 'changed_meanwhile':
        throw new ConflictException('The matter, team, role or rate changed meanwhile. Reload and try again');
      case 'created':
        return responseTime(result.entry);
    }
  }

  @Get('matters/:matterId/time-entries')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(timeListSchema)
  async listTime(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Query({ schema: timeListQuerySchema }) query: z.infer<typeof timeListQuerySchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    const page = await this.finance.listTime(matterId, session.account.id, query.before);
    if (!page) {
      throw new NotFoundException('No matter with this id');
    }
    return { timeEntries: page.timeEntries.map(responseTimeListItem), next: page.next };
  }

  @Get('time-entries/:entryId')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(timeSchema)
  async findTime(
    @Param('entryId', { schema: z.uuid() }) entryId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    const entry = await this.finance.findTime(entryId, session.account.id);
    if (!entry) {
      throw new NotFoundException('No time entry with this id');
    }
    return responseTime(entry);
  }

  @Post('time-entries/:entryId/corrections')
  @RequirePermission('time.record')
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(timeSchema)
  async correctTime(
    @Param('entryId', { schema: z.uuid() }) entryId: string,
    @Body({ schema: correctionBodySchema }) body: z.infer<typeof correctionBodySchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.finance.correctTime(entryId, body, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException('No time entry with this id');
      case 'already_voided':
        throw new ConflictException('Voided time cannot be corrected again');
      case 'changed_meanwhile':
        throw new ConflictException('The time entry, team, role or rate changed meanwhile. Reload and try again');
      case 'changed':
      case 'unchanged':
        return responseTime(result.entry);
    }
  }
}
