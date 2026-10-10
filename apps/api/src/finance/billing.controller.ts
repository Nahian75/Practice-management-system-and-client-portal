import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import type { BillDraft, BillDraftSummary, BillLine, CreditNote, IssuedBill, IssuedBillSummary } from './finance.js';
import { FinanceService, type BillingChangeResult, type FinanceActor } from './finance.service.js';
import { billAmountToPence, penceToPounds } from './money.js';

const calendarDate = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31');
const billMoney = z.string().refine((value) => {
  try { billAmountToPence(value); return true; } catch { return false; }
}, 'Invalid bill amount').transform(billAmountToPence);
const nullableText = (length: number) => text(length).nullable();
const supplierBodySchema = z.strictObject({
  name: text(200), addressLine1: text(200), addressLine2: nullableText(200), town: text(100),
  postcode: nullableText(16), country: z.string().regex(/^[A-Z]{2}$/),
  vatRegistrationNumber: z.string().trim().min(2).max(30).regex(/^[A-Z0-9 ]+$/).nullable(),
});
const lineBodySchema = z.strictObject({
  kind: z.enum(['fee', 'recharge', 'disbursement']), description: text(1_000), net: billMoney,
  vatTreatment: z.enum(['standard', 'reduced', 'zero', 'exempt', 'outside_scope']), timeEntryId: z.uuid().nullable(),
});
const draftBodySchema = z.strictObject({
  taxPoint: calendarDate, dueOn: calendarDate, supplier: supplierBodySchema, lines: z.array(lineBodySchema).min(1).max(100),
});
const creditBodySchema = z.strictObject({
  reason: text(500),
  lines: z.array(z.strictObject({ billLineId: z.uuid(), net: billMoney })).min(1).max(100),
});
const deliveryBodySchema = z.strictObject({ method: z.enum(['email', 'post', 'hand', 'other']), note: nullableText(500) });
const responseSupplierSchema = supplierBodySchema;
const responseLineSchema = z.object({
  id: z.uuid(), position: z.number().int(), kind: z.string(), description: z.string(), net: z.string(),
  vatTreatment: z.string(), timeEntryId: z.uuid().nullable(), vat: z.string(), gross: z.string(),
  time: z.object({ workerName: z.string(), workedOn: calendarDate, minutes: z.number().int(), hourlyRate: z.string() }).optional(),
});
const draftSchema = z.object({
  id: z.uuid(), matterId: z.uuid(), status: z.literal('draft'), taxPoint: calendarDate, dueOn: calendarDate,
  supplier: responseSupplierSchema, net: z.string(), vat: z.string(), gross: z.string(), lines: z.array(responseLineSchema),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const addressSchema = z.object({ addressLine1: z.string(), addressLine2: z.string().nullable(), town: z.string(), postcode: z.string().nullable(), country: z.string() });
const billSchema = z.object({
  id: z.uuid(), draftId: z.uuid(), reference: z.string(), matterId: z.uuid(), matterReference: z.string(),
  clientReference: z.string(), clientName: z.string(), clientAddress: addressSchema, supplier: responseSupplierSchema,
  taxPoint: calendarDate, dueOn: calendarDate, net: z.string(), vat: z.string(), gross: z.string(), issuedOn: calendarDate,
  issuedAt: z.iso.datetime(), lines: z.array(responseLineSchema),
});
const billSummarySchema = z.object({
  id: z.uuid(), reference: z.string(), matterId: z.uuid(), taxPoint: calendarDate, dueOn: calendarDate,
  net: z.string(), vat: z.string(), gross: z.string(), issuedOn: calendarDate, issuedAt: z.iso.datetime(),
});
const creditLineSchema = z.object({
  id: z.uuid(), position: z.number().int(), billLineId: z.uuid(), description: z.string(),
  vatTreatment: z.enum(['standard', 'reduced', 'zero', 'exempt', 'outside_scope']),
  net: z.string(), vat: z.string(), gross: z.string(),
});
const creditSchema = z.object({
  id: z.uuid(), reference: z.string(), billId: z.uuid(), billReference: z.string(), matterId: z.uuid(), reason: z.string(),
  net: z.string(), vat: z.string(), gross: z.string(), issuedOn: calendarDate, issuedAt: z.iso.datetime(), lines: z.array(creditLineSchema),
});
const billsSchema = z.object({ bills: z.array(billSummarySchema) });
const deliverySchema = z.object({ id: z.uuid() });
const draftSummarySchema = z.object({
  id: z.uuid(), matterId: z.uuid(), matterReference: z.string(), matterTitle: z.string(), clientName: z.string(),
  taxPoint: calendarDate, dueOn: calendarDate, gross: z.string(), updatedAt: z.iso.datetime(),
});
const draftListSchema = z.object({ drafts: z.array(draftSummarySchema), next: z.uuid().nullable() });
const pageSchema = z.strictObject({ before: z.uuid().optional() });

function actorFor(session: ResolvedSession, request: Request): FinanceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

function responseLine(line: BillLine) {
  return {
    ...line, net: penceToPounds(line.netPence), vat: penceToPounds(line.vatPence), gross: penceToPounds(line.grossPence),
    netPence: undefined, vatPence: undefined, grossPence: undefined,
    ...(line.time ? { time: { ...line.time, hourlyRate: penceToPounds(line.time.hourlyRatePence), hourlyRatePence: undefined } } : {}),
  };
}

function responseDraft(draft: BillDraft) {
  return {
    ...draft, net: penceToPounds(draft.netPence), vat: penceToPounds(draft.vatPence), gross: penceToPounds(draft.grossPence),
    netPence: undefined, vatPence: undefined, grossPence: undefined, lines: draft.lines.map(responseLine),
    createdAt: draft.createdAt.toISOString(), updatedAt: draft.updatedAt.toISOString(),
  };
}

function responseDraftSummary(draft: BillDraftSummary) {
  return { ...draft, gross: penceToPounds(draft.grossPence), grossPence: undefined, updatedAt: draft.updatedAt.toISOString() };
}

function responseBill(bill: IssuedBill) {
  return {
    ...bill, net: penceToPounds(bill.netPence), vat: penceToPounds(bill.vatPence), gross: penceToPounds(bill.grossPence),
    netPence: undefined, vatPence: undefined, grossPence: undefined, lines: bill.lines.map(responseLine), issuedAt: bill.issuedAt.toISOString(),
  };
}

function responseBillSummary(bill: IssuedBillSummary) {
  return {
    ...bill, net: penceToPounds(bill.netPence), vat: penceToPounds(bill.vatPence), gross: penceToPounds(bill.grossPence),
    netPence: undefined, vatPence: undefined, grossPence: undefined, issuedAt: bill.issuedAt.toISOString(),
  };
}

function responseCredit(credit: CreditNote) {
  return {
    ...credit, net: penceToPounds(credit.netPence), vat: penceToPounds(credit.vatPence), gross: penceToPounds(credit.grossPence),
    netPence: undefined, vatPence: undefined, grossPence: undefined, issuedAt: credit.issuedAt.toISOString(),
    lines: credit.lines.map((line) => ({
      ...line, net: penceToPounds(line.netPence), vat: penceToPounds(line.vatPence), gross: penceToPounds(line.grossPence),
      netPence: undefined, vatPence: undefined, grossPence: undefined,
    })),
  };
}

function details(body: z.infer<typeof draftBodySchema>) {
  return {
    taxPoint: body.taxPoint, dueOn: body.dueOn, supplier: body.supplier,
    lines: body.lines.map((line) => ({
      kind: line.kind, description: line.description, netPence: line.net,
      vatTreatment: line.vatTreatment, timeEntryId: line.timeEntryId,
    })),
  };
}

function changed<T>(result: BillingChangeResult<T>): T {
  if (result.outcome === 'not_found') throw new NotFoundException('No billing record with this id');
  if (result.outcome === 'changed_meanwhile') throw new ConflictException('The billing record changed meanwhile. Reload and try again');
  return result.value as T;
}

@Controller()
export class BillingController {
  constructor(private readonly finance: FinanceService) {}

  @Post('matters/:matterId/bill-drafts')
  @RequirePermission('bills.manage')
  @ResponseSchema(draftSchema)
  async createDraft(@Param('matterId', { schema: z.uuid() }) matterId: string, @Body({ schema: draftBodySchema }) body: z.infer<typeof draftBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseDraft(changed(await this.finance.createBillDraft(matterId, details(body), actorFor(session, request))));
  }

  @Get('finance/bill-drafts')
  @RequirePermission('bills.manage')
  @ResponseSchema(draftListSchema)
  async listDrafts(@Query({ schema: pageSchema }) query: z.infer<typeof pageSchema>) {
    const drafts = await this.finance.listBillDrafts(query.before);
    return { drafts: drafts.map(responseDraftSummary), next: drafts.length === 100 ? drafts.at(-1)!.id : null };
  }

  @Get('bill-drafts/:draftId')
  @RequirePermission('bills.manage')
  @ResponseSchema(draftSchema)
  async findDraft(@Param('draftId', { schema: z.uuid() }) id: string) {
    const draft = await this.finance.findBillDraft(id);
    if (!draft) throw new NotFoundException('No draft bill with this id');
    return responseDraft(draft);
  }

  @Put('bill-drafts/:draftId')
  @RequirePermission('bills.manage')
  @ResponseSchema(draftSchema)
  async replaceDraft(@Param('draftId', { schema: z.uuid() }) id: string, @Body({ schema: draftBodySchema }) body: z.infer<typeof draftBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseDraft(changed(await this.finance.replaceBillDraft(id, details(body), actorFor(session, request))));
  }

  @Post('bill-drafts/:draftId/issue')
  @RequirePermission('bills.manage')
  @ResponseSchema(billSchema)
  async issueBill(@Param('draftId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseBill(changed(await this.finance.issueBill(id, actorFor(session, request))));
  }

  @Get('matters/:matterId/bills')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(billsSchema)
  async listBills(@Param('matterId', { schema: z.uuid() }) matterId: string, @CurrentSession() session: ResolvedSession) {
    const bills = await this.finance.listBills(matterId, session.account.id);
    if (!bills) throw new NotFoundException('No matter with this id');
    return { bills: bills.map(responseBillSummary) };
  }

  @Get('bills/:billId')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(billSchema)
  async findBill(@Param('billId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession) {
    const bill = await this.finance.findBill(id, session.account.id);
    if (!bill) throw new NotFoundException('No bill with this id');
    return responseBill(bill);
  }

  @Post('bills/:billId/credit-notes')
  @RequirePermission('bills.manage')
  @ResponseSchema(creditSchema)
  async issueCredit(@Param('billId', { schema: z.uuid() }) id: string, @Body({ schema: creditBodySchema }) body: z.infer<typeof creditBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const lines = body.lines.map((line) => ({ billLineId: line.billLineId, netPence: line.net }));
    return responseCredit(changed(await this.finance.issueCreditNote(id, body.reason, lines, actorFor(session, request))));
  }

  @Get('credit-notes/:creditNoteId')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(creditSchema)
  async findCredit(@Param('creditNoteId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession) {
    const credit = await this.finance.findCreditNote(id, session.account.id);
    if (!credit) throw new NotFoundException('No credit note with this id');
    return responseCredit(credit);
  }

  @Post('bills/:billId/deliveries')
  @RequirePermission('bills.manage')
  @ResponseSchema(deliverySchema)
  async deliverBill(@Param('billId', { schema: z.uuid() }) id: string, @Body({ schema: deliveryBodySchema }) body: z.infer<typeof deliveryBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changed(await this.finance.recordDelivery({ billId: id, creditNoteId: null, ...body }, actorFor(session, request)));
  }

  @Post('credit-notes/:creditNoteId/deliveries')
  @RequirePermission('bills.manage')
  @ResponseSchema(deliverySchema)
  async deliverCredit(@Param('creditNoteId', { schema: z.uuid() }) id: string, @Body({ schema: deliveryBodySchema }) body: z.infer<typeof deliveryBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changed(await this.finance.recordDelivery({ billId: null, creditNoteId: id, ...body }, actorFor(session, request)));
  }

  @Get('bills/:billId/content')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(STREAMED)
  async downloadBill(@Param('billId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response): Promise<void> {
    const file = await this.finance.downloadBill(id, actorFor(session, request));
    if (!file) throw new NotFoundException('No bill with this id');
    sendFile(response, file);
  }

  @Get('credit-notes/:creditNoteId/content')
  @RequirePermission('finance.matter.view')
  @ResponseSchema(STREAMED)
  async downloadCredit(@Param('creditNoteId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response): Promise<void> {
    const file = await this.finance.downloadCreditNote(id, actorFor(session, request));
    if (!file) throw new NotFoundException('No credit note with this id');
    sendFile(response, file);
  }
}

function sendFile(response: Response, file: { fileName: string; content: Buffer }): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', String(file.content.length));
  response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  response.end(file.content);
}
