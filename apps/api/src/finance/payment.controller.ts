import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import type { ClientPaymentEventKind } from '../database/schema.js';
import type { FinanceActor } from './finance.service.js';
import { billAmountToPence, penceToPounds } from './money.js';
import { PaymentService, type PaymentChangeResult } from './payment.service.js';
import type { PaymentRequest } from './payment.js';

const calendarDate = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31');
const financeMoney = z.string().refine((value) => {
  try { billAmountToPence(value); return true; } catch { return false; }
}, 'Invalid finance amount').transform(billAmountToPence);
const commonRequest = {
  matterId: z.uuid(), clientBankAccountId: z.uuid(), evidenceDocumentId: z.uuid(),
  purpose: text(500), amount: financeMoney,
};
const payeeSchema = z.strictObject({
  name: text(200), sortCode: z.string().regex(/^\d{2}-\d{2}-\d{2}$/), accountNumber: z.string().regex(/^\d{8}$/),
});
const createRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('refund'), ...commonRequest, payee: payeeSchema }),
  z.strictObject({ kind: z.literal('third_party'), ...commonRequest, payee: payeeSchema }),
  z.strictObject({
    kind: z.literal('costs_transfer'), ...commonRequest,
    businessBankAccountId: z.uuid(), billId: z.uuid(),
  }),
]);
const personSchema = z.object({ accountId: z.uuid(), displayName: z.string() });
const eventSchema = z.object({
  id: z.uuid(), kind: z.enum(['approved', 'rejected', 'cancelled', 'paid', 'bank_rejected']),
  reason: z.string().nullable(), bankReference: z.string().nullable(), occurredOn: calendarDate.nullable(),
  financeTransactionId: z.uuid().nullable(), actedBy: personSchema, actedAt: z.iso.datetime(),
});
const paymentSchema = z.object({
  id: z.uuid(), kind: z.enum(['refund', 'third_party', 'costs_transfer']), clientId: z.uuid(), matterId: z.uuid(),
  clientBankAccountId: z.uuid(), businessBankAccountId: z.uuid().nullable(), billId: z.uuid().nullable(),
  evidenceDocumentId: z.uuid(), purpose: z.string(), amount: z.string(), requestedBy: personSchema,
  requestedAt: z.iso.datetime(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'paid', 'bank_rejected']),
  events: z.array(eventSchema),
});
const listSchema = z.object({ paymentRequests: z.array(paymentSchema), next: z.uuid().nullable() });
const pageQuerySchema = z.strictObject({ before: z.uuid().optional() });
const emptySchema = z.strictObject({});
const reasonSchema = z.strictObject({ reason: text(500) });
const paidSchema = z.strictObject({ bankReference: text(100), occurredOn: calendarDate });

function actorFor(session: ResolvedSession, request: Request): FinanceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

function changed<T>(result: PaymentChangeResult<T>): T {
  if (result.outcome === 'changed') return result.value;
  if (result.outcome === 'not_found') throw new NotFoundException('No payment request with this id');
  throw new ConflictException('The payment request cannot be changed in its current state');
}

function responsePayment(payment: PaymentRequest) {
  return {
    ...payment, amount: penceToPounds(payment.amountPence), amountPence: undefined,
    requestedAt: payment.requestedAt.toISOString(),
    events: payment.events.map((event) => ({ ...event, actedAt: event.actedAt.toISOString() })),
  };
}

@Controller('finance/payment-requests')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post()
  @RequirePermission('client_money.request')
  @ResponseSchema(paymentSchema)
  async create(@Body({ schema: createRequestSchema }) body: z.infer<typeof createRequestSchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const { amount, ...input } = body;
    const details = input.kind === 'costs_transfer'
      ? { ...input, payee: null }
      : { ...input, businessBankAccountId: null, billId: null };
    return responsePayment(changed(await this.payments.create({ ...details, amountPence: amount }, actorFor(session, request))));
  }

  @Get()
  @RequirePermission('finance.view_all')
  @ResponseSchema(listSchema)
  async list(@Query({ schema: pageQuerySchema }) query: z.infer<typeof pageQuerySchema>) {
    const result = await this.payments.list(query.before);
    return { paymentRequests: result.paymentRequests.map(responsePayment), next: result.next };
  }

  @Get(':paymentRequestId')
  @RequirePermission('finance.view_all')
  @ResponseSchema(paymentSchema)
  async find(@Param('paymentRequestId', { schema: z.uuid() }) id: string) {
    const payment = await this.payments.find(id);
    if (!payment) throw new NotFoundException('No payment request with this id');
    return responsePayment(payment);
  }

  @Get(':paymentRequestId/payee')
  @RequirePermission('client_money.record')
  @ResponseSchema(payeeSchema)
  async payee(@Param('paymentRequestId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const result = await this.payments.payee(id, actorFor(session, request));
    if (result.outcome === 'found') return result.value;
    if (result.outcome === 'not_found') throw new NotFoundException('No payment request with this id');
    throw new ConflictException('Payee details are unavailable for this request');
  }

  @Post(':paymentRequestId/approve')
  @RequirePermission('client_money.approve')
  @ResponseSchema(paymentSchema)
  approve(@Param('paymentRequestId', { schema: z.uuid() }) id: string, @Body({ schema: emptySchema }) _body: object, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return this.record(id, 'approved', null, null, null, session, request);
  }

  @Post(':paymentRequestId/reject')
  @RequirePermission('client_money.approve')
  @ResponseSchema(paymentSchema)
  reject(@Param('paymentRequestId', { schema: z.uuid() }) id: string, @Body({ schema: reasonSchema }) body: z.infer<typeof reasonSchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return this.record(id, 'rejected', body.reason, null, null, session, request);
  }

  @Post(':paymentRequestId/cancel')
  @RequirePermission('client_money.request')
  @ResponseSchema(paymentSchema)
  cancel(@Param('paymentRequestId', { schema: z.uuid() }) id: string, @Body({ schema: reasonSchema }) body: z.infer<typeof reasonSchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return this.record(id, 'cancelled', body.reason, null, null, session, request);
  }

  @Post(':paymentRequestId/paid')
  @RequirePermission('client_money.record')
  @ResponseSchema(paymentSchema)
  paid(@Param('paymentRequestId', { schema: z.uuid() }) id: string, @Body({ schema: paidSchema }) body: z.infer<typeof paidSchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return this.record(id, 'paid', null, body.bankReference, body.occurredOn, session, request);
  }

  @Post(':paymentRequestId/bank-rejected')
  @RequirePermission('client_money.record')
  @ResponseSchema(paymentSchema)
  bankRejected(@Param('paymentRequestId', { schema: z.uuid() }) id: string, @Body({ schema: reasonSchema }) body: z.infer<typeof reasonSchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return this.record(id, 'bank_rejected', body.reason, null, null, session, request);
  }

  private async record(id: string, kind: ClientPaymentEventKind, reason: string | null, bankReference: string | null, occurredOn: string | null, session: ResolvedSession, request: Request) {
    return responsePayment(changed(await this.payments.event(
      id, { kind, reason, bankReference, occurredOn }, actorFor(session, request),
    )));
  }
}
